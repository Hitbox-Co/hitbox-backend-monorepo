import { ApprovalAuthority, ApprovalStatus, ComplianceStatus } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    LEGAL_COMPLIANCE_STATEMENT,
    LEGAL_COMPLIANCE_VERSION,
    RELEASE_EVENTS,
    RELEASES_ERROR_CODES,
} from '../constants/releases.constant';
import {
    auditActorType,
    canApprove,
    canOverrideDecision,
    canReject,
    resolveAuthority,
} from '../domain/approval-authority';
import type { DecidingActor } from '../domain/approval-authority';
import type { IReleaseAudit } from '../domain/interfaces/release-audit.interface';
import type {
    DecideReleaseApprovalDto,
    ReopenReleaseApprovalDto,
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
    /**
     * The caller, for the authority rule.
     *
     * Distinct from `organizationIds`, which is the *read* scope and is `null`
     * for anyone holding a global grant. Membership is what decides whether
     * somebody may approve for a brand, and a platform administrator is a
     * member of none.
     */
    actor: DecidingActor;
    /** This request's correlation id, for the audit trail. */
    correlationId: string;
}

export interface ReleaseServiceDeps {
    releases: ReleaseRepository;
    eventBus: IEventBus;
    logger: Logger;
    /**
     * The compliance trail. Every submit, decision, amendment and reopen is
     * recorded through it — `record()` rather than `emit()`, because an
     * approval nobody can account for is not an approval.
     */
    audit: IReleaseAudit;
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

        const decided = approval.decidedAt !== null;
        const approveCheck = canApprove(approval, view.actor);
        const rejectCheck = canReject(approval, view.actor);

        // Decided rows need the override rule on top of the authority rule.
        const approveAllowed = approveCheck.allowed && !decided;
        const approveBlockedReason = decided
            ? canOverrideDecision('APPROVED', view.actor).reason
            : approveCheck.reason;
        const rejectAllowed =
            rejectCheck.allowed && (!decided || canOverrideDecision('REJECTED', view.actor).allowed);

        return {
            ...toListItem(approval),
            history: history.map((row) => ({
                id: row.id,
                version: row.version,
                status: row.status,
                comment: row.comment,
                complianceStatus: row.complianceStatus,
                authority: row.authority,
                approverId: row.approverId,
                approverEmail: row.approver?.email ?? null,
                checkedById: row.checkedById,
                legalComplianceAccepted: row.legalComplianceAccepted,
                legalComplianceVersion: row.legalComplianceVersion,
                reopenedFromVersion: row.reopenedFromVersion,
                reopenReason: row.reopenReason,
                decidedAt: row.decidedAt?.toISOString() ?? null,
                createdAt: row.createdAt.toISOString(),
            })),
            canDecide: approveAllowed || rejectAllowed,
            blockedReason: approveAllowed || rejectAllowed ? null : approveBlockedReason,
            canApprove: approveAllowed,
            canReject: rejectAllowed,
            canReopen: decided && view.actor.canOverride,
            approveBlockedReason: approveAllowed ? null : approveBlockedReason,
            legalComplianceStatement: LEGAL_COMPLIANCE_STATEMENT,
            legalComplianceVersionRequired: LEGAL_COMPLIANCE_VERSION,
        };
    }

    /** Opens a review at version N+1 and moves the drop to SUBMITTED. */
    async submitForReview(
        dto: SubmitForReviewDto,
        actorId: string,
        correlationId: string,
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

        // Who owns this drop decides who signs it off. Resolved now and frozen
        // on the row — a drop that later moves between a brand and an artist
        // must not retroactively change who was accountable.
        const ownership = await this.deps.releases.findOwnership(dto.productId);
        if (!ownership) {
            throw AppError.notFound('Product not found.', RELEASES_ERROR_CODES.NOT_FOUND);
        }
        const authority = resolveAuthority(ownership);

        const approval = await this.deps.releases.submit({
            productId: dto.productId,
            approverId: actorId,
            version,
            comment: dto.comment,
            complianceStatus: ComplianceStatus.PENDING,
            oddsDisclosureRef: null,
            ...authority,
        });

        await this.deps.audit.record({
            eventType: 'release.submit',
            actorId,
            actorType: auditActorType(authority, {
                userId: actorId,
                memberOrganizationIds: [],
                artistId: null,
                canDecide: true,
                canOverride: false,
            }),
            organizationId: ownership.organizationId,
            approvalId: approval.id,
            productId: dto.productId,
            result: 'SUCCESS',
            correlationId,
            after: { version, status: ApprovalStatus.PENDING, ...authority },
            metadata: { comment: dto.comment ?? null },
        });

        await this.deps.eventBus.publish(RELEASE_EVENTS.SUBMITTED, {
            approvalId: approval.id,
            productId: dto.productId,
            version,
            actorId,
            ...authority,
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
        const { correlationId } = view;
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

        await this.deps.audit.record({
            eventType: 'release.amend',
            actorId: view.actor.userId,
            actorType: auditActorType(approval, view.actor),
            organizationId: approval.drop.organizationId,
            approvalId: id,
            productId: approval.productId,
            result: 'SUCCESS',
            correlationId,
            before: {
                comment: approval.comment,
                complianceStatus: approval.complianceStatus,
                oddsDisclosureRef: approval.oddsDisclosureRef,
            },
            after: dto as Record<string, unknown>,
        });
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
        const { correlationId } = input.view;
        const approval = await this.requireInScope(input.id, input.view);
        const approving = input.dto.status === ApprovalStatus.APPROVED;

        // ── Is this caller entitled to decide *this* drop? ──────────────────
        //
        // Checked before anything else, and audited as DENIED when it fails:
        // an administrator trying to approve a brand's drop is exactly the
        // event a compliance review wants to see, and it leaves no other trace.
        const entitled = approving
            ? canApprove(approval, input.view.actor)
            : canReject(approval, input.view.actor);

        if (!entitled.allowed) {
            await this.deps.audit.record({
                eventType: approving ? 'release.approve' : 'release.reject',
                actorId: input.actorId,
                actorType: auditActorType(approval, input.view.actor),
                organizationId: approval.drop.organizationId,
                approvalId: approval.id,
                productId: approval.productId,
                result: 'DENIED',
                correlationId,
                metadata: {
                    reason: entitled.reason,
                    authority: approval.authority,
                    requiredArtistId: approval.requiredArtistId,
                    requiredOrganizationId: approval.requiredOrganizationId,
                },
            });
            throw AppError.forbidden(
                entitled.reason ?? 'You may not decide this release.',
                RELEASES_ERROR_CODES.NOT_THE_APPROVER,
            );
        }

        // Reversing a decision already recorded is a different, narrower
        // power — and never toward APPROVED. See canOverrideDecision.
        if (approval.decidedAt !== null) {
            const override = canOverrideDecision(
                approving ? 'APPROVED' : 'REJECTED',
                input.view.actor,
            );
            if (!override.allowed) {
                throw AppError.conflict(
                    override.reason ?? 'This review has already been decided.',
                    RELEASES_ERROR_CODES.ALREADY_DECIDED,
                );
            }
        }

        // The tickmark. The schema already refuses an approval without it, so
        // reaching here with it unset means the DTO was bypassed.
        if (approving && input.dto.acceptLegalCompliance !== true) {
            throw AppError.badRequest(
                'You must accept the legal compliance statement to approve this release.',
                RELEASES_ERROR_CODES.LEGAL_ACCEPTANCE_REQUIRED,
            );
        }

        const complianceStatus =
            input.dto.complianceStatus ??
            (approving ? ComplianceStatus.CLEARED : ComplianceStatus.FLAGGED);
        const oddsRef = input.dto.oddsDisclosureRef ?? approval.oddsDisclosureRef ?? undefined;

        if (approving) {
            if (approval.drop.isAgeSpecific && approval.drop.minimumAge === null) {
                throw AppError.badRequest(
                    'This drop is age-restricted but carries no minimum age. Set one before approving.',
                    RELEASES_ERROR_CODES.COMPLIANCE_INCOMPLETE,
                    { field: 'minimumAge' },
                );
            }
            if (complianceStatus === ComplianceStatus.CLEARED && !oddsRef && approval.drop.oddsDisclosureRef === null) {
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
            legalComplianceAccepted: approving,
            legalComplianceVersion: approving ? LEGAL_COMPLIANCE_VERSION : null,
        });

        if (changed === 0) {
            throw AppError.conflict(
                'This review was decided while you were working on it. Reload and try again.',
                RELEASES_ERROR_CODES.ALREADY_DECIDED,
            );
        }

        await this.deps.audit.record({
            eventType: approving ? 'release.approve' : 'release.reject',
            actorId: input.actorId,
            actorType: auditActorType(approval, input.view.actor),
            organizationId: approval.drop.organizationId,
            approvalId: input.id,
            productId: approval.productId,
            result: 'SUCCESS',
            correlationId,
            before: { status: approval.status, decidedAt: approval.decidedAt },
            after: {
                status: input.dto.status,
                complianceStatus,
                legalComplianceAccepted: approving,
                legalComplianceVersion: approving ? LEGAL_COMPLIANCE_VERSION : null,
            },
            metadata: {
                authority: approval.authority,
                // The rejection note, kept in the trail as well as on the row:
                // the row can be superseded by a later version, the trail cannot.
                note: input.dto.comment ?? null,
                override: approval.decidedAt !== null,
            },
        });

        await this.deps.eventBus.publish(RELEASE_EVENTS.DECIDED, {
            approvalId: input.id,
            productId: approval.productId,
            status: input.dto.status,
            complianceStatus,
            actorId: input.actorId,
            authority: approval.authority,
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

    /**
     * Send a decided review back so the owner can decide again.
     *
     * This is the administrator's answer to a rejection they disagree with, and
     * to an owner who rejected by mistake. It does **not** approve anything: it
     * opens version N+1 in PENDING with the same authority as the version it
     * came from, so the same party is asked again — with the administrator's
     * reason attached, which is the first thing they will read.
     *
     * A new version rather than clearing `decidedAt` on the old one, because
     * the rejection is evidence. "Why was this bounced twice" has to stay
     * answerable.
     */
    async reopen(input: {
        id: string;
        dto: ReopenReleaseApprovalDto;
        view: ReleaseView;
        actorId: string;
    }): Promise<ReleaseApprovalDetail> {
        const { correlationId } = input.view;
        const approval = await this.requireInScope(input.id, input.view);

        if (!input.view.actor.canOverride) {
            await this.deps.audit.record({
                eventType: 'release.reopen',
                actorId: input.actorId,
            actorType: auditActorType(approval, input.view.actor),
                organizationId: approval.drop.organizationId,
                approvalId: approval.id,
                productId: approval.productId,
                result: 'DENIED',
                correlationId,
                metadata: { reason: 'caller holds no override capability' },
            });
            throw AppError.forbidden(
                'Reopening a decided review requires the override permission.',
                RELEASES_ERROR_CODES.NOT_THE_APPROVER,
            );
        }

        if (approval.decidedAt === null) {
            throw AppError.conflict(
                'This review has not been decided yet, so there is nothing to reopen.',
                RELEASES_ERROR_CODES.NOT_REOPENABLE,
            );
        }

        const open = await this.deps.releases.findOpenForProduct(approval.productId);
        if (open) {
            throw AppError.conflict(
                `This drop already has an open review at version ${open.version}.`,
                RELEASES_ERROR_CODES.ALREADY_PENDING,
                { approvalId: open.id, version: open.version },
            );
        }

        const version = (await this.deps.releases.findLatestVersion(approval.productId)) + 1;
        const reopened = await this.deps.releases.submit({
            productId: approval.productId,
            // The owner is the approver of record again, not the administrator
            // who reopened it — `reopenedById` is where that is recorded.
            approverId: approval.approverId,
            version,
            comment: undefined,
            complianceStatus: ComplianceStatus.PENDING,
            oddsDisclosureRef: approval.oddsDisclosureRef,
            // Carried forward, not re-derived: the drop's owner may have
            // changed since, and the party that was asked should be asked again.
            authority: approval.authority,
            requiredArtistId: approval.requiredArtistId,
            requiredOrganizationId: approval.requiredOrganizationId,
            reopenedFromVersion: approval.version,
            reopenedById: input.actorId,
            reopenReason: input.dto.reason,
        });

        await this.deps.audit.record({
            eventType: 'release.reopen',
            actorId: input.actorId,
            actorType: auditActorType(approval, input.view.actor),
            organizationId: approval.drop.organizationId,
            approvalId: reopened.id,
            productId: approval.productId,
            result: 'SUCCESS',
            correlationId,
            before: { version: approval.version, status: approval.status },
            after: { version, status: ApprovalStatus.PENDING },
            metadata: { reason: input.dto.reason, reopenedFrom: approval.id },
        });

        await this.deps.eventBus.publish(RELEASE_EVENTS.REOPENED, {
            approvalId: reopened.id,
            reopenedFromId: approval.id,
            productId: approval.productId,
            version,
            actorId: input.actorId,
        });
        this.deps.logger.info(
            {
                approvalId: reopened.id,
                productId: approval.productId,
                fromVersion: approval.version,
                version,
            },
            'release reopened for another decision',
        );

        return this.getById(reopened.id, input.view);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Out-of-scope and missing return the same 404 — a distinct 403 would
     * confirm a drop exists under review in another organization.
     */
    private async requireInScope(id: string, view: ReleaseView): Promise<ReleaseApprovalRow> {
        const approval = await this.deps.releases.findById(id);
        const visible =
            approval !== null &&
            (view.organizationIds === null ||
                (approval.drop.organizationId !== null &&
                    view.organizationIds.includes(approval.drop.organizationId)));

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
        authority: row.authority,
        requiredArtistId: row.requiredArtistId,
        requiredArtistName: row.requiredArtist?.name ?? null,
        requiredOrganizationId: row.requiredOrganizationId,
        requiredOrganizationName: row.requiredOrganization?.name ?? null,
        legalComplianceAccepted: row.legalComplianceAccepted,
        legalComplianceAcceptedAt: row.legalComplianceAcceptedAt?.toISOString() ?? null,
        legalComplianceVersion: row.legalComplianceVersion,
        reopenedFromVersion: row.reopenedFromVersion,
        reopenedById: row.reopenedById,
        reopenedAt: row.reopenedAt?.toISOString() ?? null,
        reopenReason: row.reopenReason,
        product: {
            id: row.drop.id,
            groupCode: row.drop.groupCode,
            name: row.drop.name,
            status: row.drop.status,
            complianceStatus: row.drop.complianceStatus,
            isAgeSpecific: row.drop.isAgeSpecific,
            minimumAge: row.drop.minimumAge,
            oddsDisclosureRef: row.drop.oddsDisclosureRef,
            totalSupply: row.drop.totalSupply,
            organizationId: row.drop.organizationId,
            artistId: row.drop.artistId,
        },
    };
}
