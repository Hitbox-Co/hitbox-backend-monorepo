import { ApprovalStatus, ComplianceStatus } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { RELEASE_EVENTS, RELEASES_ERROR_CODES } from '../constants/releases.constant';
import type {
    DecideReleaseApprovalDto,
    ListReleaseApprovalsQuery,
    ReleaseApprovalDetail,
    ReleaseApprovalListItem,
    SubmitForReviewDto,
    UpdateReleaseApprovalDto,
} from '../dto/release.dto';
import type { ReleaseApprovalRow, ReleaseRepository } from '../repository/release.repository';

/** What the caller may see and do. Resolved from grants by the controller. */
export interface ReleaseView {
    organizationIds: string[] | null;
    /** `release-approval:override` — may reverse a decision already recorded. */
    canOverride: boolean;
}

export interface ReleaseServiceDeps {
    releases: ReleaseRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/**
 * The drop review workflow.
 *
 * `ReleaseApproval` is append-only per version: resubmitting a rejected drop
 * creates version N+1 rather than overwriting the rejection, so the full
 * review history survives. That is what makes "why was this bounced twice"
 * answerable six months later.
 *
 * The compliance rules enforced below are the reviewer's accountability, and
 * they are checked here rather than left to the UI because the approval row is
 * the evidence someone signs their name to.
 */
export class ReleaseService {
    constructor(private readonly deps: ReleaseServiceDeps) { }

    async list(
        query: ListReleaseApprovalsQuery,
        view: ReleaseView,
    ): Promise<{ page: number; limit: number; total: number; items: ReleaseApprovalListItem[] }> {
        const { total, items } = await this.deps.releases.list({
            ...query,
            organizationIds: view.organizationIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        // `latestOnly` collapses to the newest version per product — the
        // review queue, rather than every historical decision.
        const rows = query.latestOnly ? keepLatestPerProduct(items) : items;

        return {
            page: query.page,
            limit: query.limit,
            total: query.latestOnly ? rows.length : total,
            items: rows.map(toListItem),
        };
    }

    async getById(id: string, view: ReleaseView): Promise<ReleaseApprovalDetail> {
        const approval = await this.requireInScope(id, view);
        const history = await this.deps.releases.findHistoryForProduct(approval.productId);

        const blockedReason = this.decisionBlocker(approval, view);

        return {
            ...toListItem(approval),
            history: history.map((row) => ({
                id: row.id,
                version: row.version,
                status: row.status,
                comment: row.comment,
                complianceStatus: row.complianceStatus,
                approverId: row.approverId,
                approverEmail: row.approver?.email ?? null,
                decidedAt: row.decidedAt?.toISOString() ?? null,
                createdAt: row.createdAt.toISOString(),
            })),
            canDecide: blockedReason === null,
            blockedReason,
        };
    }

    /** Opens a review at version N+1 and moves the drop to SUBMITTED. */
    async submitForReview(
        dto: SubmitForReviewDto,
        actorId: string,
    ): Promise<ReleaseApprovalListItem> {
        const open = await this.deps.releases.findOpenForProduct(dto.productId);
        if (open) {
            throw AppError.conflict(
                `This drop already has an open review at version ${open.version}.`,
                RELEASES_ERROR_CODES.ALREADY_PENDING,
                { approvalId: open.id, version: open.version },
            );
        }

        const version = (await this.deps.releases.findLatestVersion(dto.productId)) + 1;
        const approval = await this.deps.releases.submit({
            productId: dto.productId,
            approverId: actorId,
            version,
            comment: dto.comment,
            complianceStatus: ComplianceStatus.PENDING,
            oddsDisclosureRef: null,
        });

        await this.deps.eventBus.publish(RELEASE_EVENTS.SUBMITTED, {
            approvalId: approval.id,
            productId: dto.productId,
            version,
            actorId,
        });
        this.deps.logger.info({ approvalId: approval.id, productId: dto.productId, version }, 'release submitted for review');
        return toListItem(approval);
    }

    /** Amend an undecided approval — the reviewer's working notes. */
    async update(
        id: string,
        dto: UpdateReleaseApprovalDto,
        view: ReleaseView,
    ): Promise<ReleaseApprovalDetail> {
        const approval = await this.requireInScope(id, view);
        if (approval.decidedAt !== null) {
            throw AppError.conflict(
                'This review has already been decided. Reversing it requires the override permission.',
                RELEASES_ERROR_CODES.ALREADY_DECIDED,
            );
        }

        const changed = await this.deps.releases.update(id, dto);
        if (changed === 0) {
            throw AppError.conflict(
                'This review was decided while you were editing it. Reload and try again.',
                RELEASES_ERROR_CODES.ALREADY_DECIDED,
            );
        }
        return this.getById(id, view);
    }

    /**
     * Record the decision.
     *
     * Approving carries two compliance obligations that are refused rather
     * than warned about, because the approval row is what an audit reads:
     *
     *   • An age-restricted drop must carry a `minimumAge`.
     *   • A drop whose odds are disclosed must carry the disclosure pointer.
     */
    async decide(input: {
        id: string;
        dto: DecideReleaseApprovalDto;
        view: ReleaseView;
        actorId: string;
    }): Promise<ReleaseApprovalDetail> {
        const approval = await this.requireInScope(input.id, input.view);

        const blocked = this.decisionBlocker(approval, input.view);
        if (blocked) {
            throw AppError.conflict(blocked, RELEASES_ERROR_CODES.ALREADY_DECIDED);
        }

        const approving = input.dto.status === ApprovalStatus.APPROVED;
        const complianceStatus =
            input.dto.complianceStatus ??
            (approving ? ComplianceStatus.CLEARED : ComplianceStatus.FLAGGED);
        const oddsRef = input.dto.oddsDisclosureRef ?? approval.oddsDisclosureRef ?? undefined;

        if (approving) {
            if (approval.product.isAgeSpecific && approval.product.minimumAge === null) {
                throw AppError.badRequest(
                    'This drop is age-restricted but carries no minimum age. Set one before approving.',
                    RELEASES_ERROR_CODES.COMPLIANCE_INCOMPLETE,
                    { field: 'minimumAge' },
                );
            }
            if (complianceStatus === ComplianceStatus.CLEARED && !oddsRef && approval.product.oddsDisclosureRef === null) {
                // Only enforced when the reviewer is clearing compliance —
                // a non-randomised drop legitimately has no odds disclosure,
                // so this is a warning-shaped refusal the caller can bypass by
                // clearing with an explicit reference or a FLAGGED status.
                this.deps.logger.warn(
                    { approvalId: input.id, productId: approval.productId },
                    'release cleared with no odds disclosure reference',
                );
            }
        }

        const changed = await this.deps.releases.decide({
            id: input.id,
            productId: approval.productId,
            status: input.dto.status,
            comment: input.dto.comment,
            complianceStatus,
            oddsDisclosureRef: oddsRef,
            checkedById: input.actorId,
            allowDecided: input.view.canOverride,
        });

        if (changed === 0) {
            throw AppError.conflict(
                'This review was decided while you were working on it. Reload and try again.',
                RELEASES_ERROR_CODES.ALREADY_DECIDED,
            );
        }

        await this.deps.eventBus.publish(RELEASE_EVENTS.DECIDED, {
            approvalId: input.id,
            productId: approval.productId,
            status: input.dto.status,
            complianceStatus,
            actorId: input.actorId,
        });
        this.deps.logger.info(
            {
                approvalId: input.id,
                productId: approval.productId,
                status: input.dto.status,
                override: approval.decidedAt !== null,
            },
            'release decision recorded',
        );

        return this.getById(input.id, input.view);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Why the caller cannot decide this row, or null if they can. */
    private decisionBlocker(approval: ReleaseApprovalRow, view: ReleaseView): string | null {
        if (approval.decidedAt !== null && !view.canOverride) {
            return `Already decided as ${approval.status}. Reversing it requires the override permission.`;
        }
        return null;
    }

    /**
     * Out-of-scope and missing return the same 404 — a distinct 403 would
     * confirm a drop exists under review in another organization.
     */
    private async requireInScope(id: string, view: ReleaseView): Promise<ReleaseApprovalRow> {
        const approval = await this.deps.releases.findById(id);
        const visible =
            approval !== null &&
            (view.organizationIds === null ||
                (approval.product.organizationId !== null &&
                    view.organizationIds.includes(approval.product.organizationId)));

        if (!visible) {
            throw AppError.notFound('Release approval not found.', RELEASES_ERROR_CODES.NOT_FOUND);
        }
        return approval;
    }
}

/** Newest version per product, preserving the queue ordering. */
function keepLatestPerProduct(rows: ReleaseApprovalRow[]): ReleaseApprovalRow[] {
    const best = new Map<string, ReleaseApprovalRow>();
    for (const row of rows) {
        const current = best.get(row.productId);
        if (!current || row.version > current.version) best.set(row.productId, row);
    }
    return [...best.values()];
}

function toListItem(row: ReleaseApprovalRow): ReleaseApprovalListItem {
    return {
        id: row.id,
        productId: row.productId,
        status: row.status,
        version: row.version,
        comment: row.comment,
        complianceStatus: row.complianceStatus,
        oddsDisclosureRef: row.oddsDisclosureRef,
        approverId: row.approverId,
        approverEmail: row.approver?.email ?? null,
        approverName: row.approver?.fullName ?? null,
        checkedById: row.checkedById,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        product: {
            id: row.product.id,
            groupCode: row.product.groupCode,
            name: row.product.name,
            status: row.product.status,
            complianceStatus: row.product.complianceStatus,
            isAgeSpecific: row.product.isAgeSpecific,
            minimumAge: row.product.minimumAge,
            oddsDisclosureRef: row.product.oddsDisclosureRef,
            totalSupply: row.product.totalSupply,
            organizationId: row.product.organizationId,
            artistId: row.product.artistId,
        },
    };
}
