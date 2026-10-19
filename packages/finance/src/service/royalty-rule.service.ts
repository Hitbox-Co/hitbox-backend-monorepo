import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { RoyaltyRule } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { FINANCE_DECISION_ERROR_CODES, FINANCE_ERROR_CODES } from '../constants/finance.constant';
import type { PublicCodeResolver } from '../domain/public-codes';
import type { FinanceAccess } from '../domain/finance-access';
import { requireManage } from '../domain/finance-access';
import type {
    CloseRoyaltyRuleDto,
    CreateRoyaltyRuleDto,
    ListRoyaltyRulesQuery,
    RoyaltyRuleView,
} from '../dto/finance.dto';
import type { RoyaltyRuleRepository } from '../repository/royalty-rule.repository';

export interface RoyaltyRuleServiceDeps {
    rules: RoyaltyRuleRepository;
    codes: PublicCodeResolver;
    logger: Logger;
}

/**
 * Royalty rules: the terms of a deal, versioned rather than mutable.
 *
 * There is no update endpoint and that is the design, not an omission. A rule
 * that has priced an accrual cannot change its percentage retroactively
 * without making every entry posted under it unexplainable, so a
 * renegotiation is *close the old rule, create the successor* — two rows, both
 * permanent, and a February order still reproduces February's number.
 */
export class RoyaltyRuleService {
    constructor(private readonly deps: RoyaltyRuleServiceDeps) { }

    async list(
        query: ListRoyaltyRulesQuery,
        access: FinanceAccess,
    ): Promise<{ page: number; limit: number; total: number; items: RoyaltyRuleView[] }> {
        const { total, items } = await this.deps.rules.list({
            ...query,
            organizationIds: access.organizationIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        const now = new Date();
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: await this.decorate(items, now),
        };
    }

    async getById(id: string, access: FinanceAccess): Promise<RoyaltyRuleView> {
        const rule = await this.requireInScope(id, access);
        return (await this.decorate([rule], new Date()))[0] as RoyaltyRuleView;
    }

    async create(
        dto: CreateRoyaltyRuleDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<RoyaltyRuleView> {
        requireManage(access, 'create royalty rules');

        // MVP: net-profit royalties, set per artist. Legacy rows of any other
        // basis or scope keep resolving; they just cannot be created any more.
        if (dto.basis !== 'NET_PROFIT') {
            throw AppError.badRequest(
                'Only NET_PROFIT royalty rules can be created.',
                FINANCE_DECISION_ERROR_CODES.BASIS_NOT_SUPPORTED,
                { basis: dto.basis },
            );
        }
        if (!dto.artistId || dto.organizationId || dto.collectionId || dto.productId) {
            throw AppError.badRequest(
                'Royalty rules can only be scoped to an artist (artistId), not to a product, collection or organization.',
                FINANCE_DECISION_ERROR_CODES.RULE_SCOPE_NOT_SUPPORTED,
            );
        }

        const effectiveFrom = dto.effectiveFrom ?? new Date();
        const splitConfig = dto.splits?.length
            ? {
                splits: dto.splits.map((split) => ({
                    payeeType: split.payeeType,
                    artistId: split.artistId ?? null,
                    organizationId: split.organizationId ?? null,
                    percentage: split.percentage,
                })),
            }
            : {};

        // A multi-party deal whose shares exceed 100% of the base is almost
        // always a typo, and the cost of the typo is money paid out that the
        // platform never took in. Refuse it here rather than discovering it in
        // a reconciliation three weeks later.
        if (dto.splits?.length) {
            const total = dto.splits.reduce(
                (sum, split) => sum.plus(new Prisma.Decimal(split.percentage)),
                new Prisma.Decimal(0),
            );
            if (total.greaterThan(100)) {
                throw AppError.badRequest(
                    `The splits on this rule total ${total.toString()}%, which is more than the revenue they divide.`,
                    FINANCE_ERROR_CODES.INVALID_RULE,
                    { totalPercentage: total.toString() },
                );
            }
        }

        const created = await this.deps.rules.create({
            id: randomUUID(),
            organizationId: dto.organizationId ?? null,
            artistId: dto.artistId ?? null,
            collectionId: dto.collectionId ?? null,
            productId: dto.productId ?? null,
            basis: dto.basis,
            splitType: dto.splitType,
            splitConfig: splitConfig as Prisma.InputJsonValue,
            percentage: dto.percentage ? new Prisma.Decimal(dto.percentage) : null,
            payoutThreshold: dto.payoutThreshold
                ? new Prisma.Decimal(dto.payoutThreshold)
                : null,
            payoutFrequency: dto.payoutFrequency ?? null,
            effectiveFrom,
            effectiveTo: dto.effectiveTo ?? null,
            createdAt: new Date(),
        });

        this.deps.logger.info(
            { ruleId: created.id, actorId, basis: created.basis },
            'royalty rule created',
        );
        return (await this.decorate([created], new Date()))[0] as RoyaltyRuleView;
    }

    /** Ends a rule's effective window. The row itself is never deleted. */
    async close(
        id: string,
        dto: CloseRoyaltyRuleDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<RoyaltyRuleView> {
        requireManage(access, 'close royalty rules');
        const rule = await this.requireInScope(id, access);

        if (rule.effectiveTo !== null) {
            throw AppError.conflict(
                'This rule has already been closed.',
                FINANCE_ERROR_CODES.INVALID_TRANSITION,
                { effectiveTo: rule.effectiveTo.toISOString() },
            );
        }
        if (dto.effectiveTo.getTime() <= rule.effectiveFrom.getTime()) {
            throw AppError.badRequest(
                'A rule cannot end before it started.',
                FINANCE_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const changed = await this.deps.rules.close(id, dto.effectiveTo);
        if (changed === 0) {
            throw AppError.conflict(
                'This rule changed while you were editing it. Reload and try again.',
                FINANCE_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        this.deps.logger.info(
            { ruleId: id, actorId, effectiveTo: dto.effectiveTo, reason: dto.reason },
            'royalty rule closed',
        );
        const reloaded = await this.deps.rules.findById(id);
        return (await this.decorate([reloaded as RoyaltyRule], new Date()))[0] as RoyaltyRuleView;
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Out of scope and missing return the same 404, for the same reason the
     * orders module does it: a distinct 403 confirms the rule exists, and the
     * existence of a rule scoped to another brand is itself commercial
     * information.
     */
    private async requireInScope(id: string, access: FinanceAccess): Promise<RoyaltyRule> {
        const rule = await this.deps.rules.findById(id);
        const visible =
            rule !== null &&
            (access.organizationIds === null ||
                (rule.organizationId !== null &&
                    access.organizationIds.includes(rule.organizationId)));
        if (!visible) {
            throw AppError.notFound('Royalty rule not found.', FINANCE_ERROR_CODES.NOT_FOUND);
        }
        return rule;
    }

    /** Fills the public codes for a page of rules in one query per model. */
    private async decorate(rules: RoyaltyRule[], now: Date): Promise<RoyaltyRuleView[]> {
        const codes = await this.deps.codes.resolve({
            artist: rules.map((r) => r.artistId),
            drop: rules.map((r) => r.productId),
            artistCollection: rules.map((r) => r.collectionId),
            organization: rules.map((r) => r.organizationId),
        });
        return rules.map((rule) => {
            const view = this.toView(rule, now);
            return {
                ...view,
                scope: {
                    ...view.scope,
                    artistPublicCode: codes.get('artist', rule.artistId),
                    productPublicCode: codes.get('drop', rule.productId),
                    collectionPublicCode: codes.get('artistCollection', rule.collectionId),
                    organizationPublicCode: codes.get('organization', rule.organizationId),
                },
            };
        });
    }

    private toView(rule: RoyaltyRule, now: Date): RoyaltyRuleView {
        return {
            id: rule.id,
            publicCode: rule.publicCode,
            scope: {
                organizationId: rule.organizationId,
                artistId: rule.artistId,
                collectionId: rule.collectionId,
                productId: rule.productId,
                organizationPublicCode: null,
                artistPublicCode: null,
                collectionPublicCode: null,
                productPublicCode: null,
            },
            basis: rule.basis,
            splitType: rule.splitType,
            percentage: rule.percentage?.toString() ?? null,
            splitConfig: rule.splitConfig,
            payoutThreshold: rule.payoutThreshold?.toString() ?? null,
            payoutFrequency: rule.payoutFrequency,
            effectiveFrom: rule.effectiveFrom.toISOString(),
            effectiveTo: rule.effectiveTo?.toISOString() ?? null,
            isInForce:
                rule.effectiveFrom.getTime() <= now.getTime() &&
                (rule.effectiveTo === null || rule.effectiveTo.getTime() > now.getTime()),
            createdAt: rule.createdAt.toISOString(),
        };
    }
}
