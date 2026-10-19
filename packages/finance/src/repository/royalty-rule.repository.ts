import { Prisma } from '@hitbox/database';
import type { PrismaClient, RoyaltyRule } from '@hitbox/database';
import type { ListRoyaltyRulesQuery } from '../dto/finance.dto';

/** One of the two places in this module that touches Prisma for rules. */
export class RoyaltyRuleRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Every rule that *could* apply to one sale.
     *
     * Deliberately over-fetches: the four scopes are ORed here and the winner
     * is picked in `resolveRule`, in memory. Two reasons — the precedence
     * order (product → collection → artist → organization) is a business rule
     * and belongs next to the arithmetic it feeds rather than in a query
     * planner, and a handful of rows per product means the "expensive" version
     * costs one indexed lookup.
     */
    findCandidates(scope: {
        productId: string;
        collectionId: string | null;
        artistId: string | null;
        organizationId: string | null;
    }): Promise<RoyaltyRule[]> {
        const clauses: Prisma.RoyaltyRuleWhereInput[] = [{ productId: scope.productId }];
        if (scope.collectionId) clauses.push({ collectionId: scope.collectionId });
        if (scope.artistId) clauses.push({ artistId: scope.artistId });
        if (scope.organizationId) clauses.push({ organizationId: scope.organizationId });

        return this.prisma.royaltyRule.findMany({
            where: { OR: clauses },
            orderBy: { effectiveFrom: 'desc' },
        });
    }

    findById(id: string): Promise<RoyaltyRule | null> {
        return this.prisma.royaltyRule.findUnique({ where: { id } });
    }

    async list(
        query: ListRoyaltyRulesQuery & {
            organizationIds: string[] | null;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: RoyaltyRule[] }> {
        const where: Prisma.RoyaltyRuleWhereInput = {
            ...(query.organizationIds === null
                ? {}
                : { organizationId: { in: query.organizationIds } }),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.artistId ? { artistId: query.artistId } : {}),
            ...(query.collectionId ? { collectionId: query.collectionId } : {}),
            ...(query.productId ? { productId: query.productId } : {}),
            ...(query.activeAt
                ? {
                    effectiveFrom: { lte: query.activeAt },
                    OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.activeAt } }],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.royaltyRule.count({ where }),
            this.prisma.royaltyRule.findMany({
                where,
                orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(data: Prisma.RoyaltyRuleUncheckedCreateInput): Promise<RoyaltyRule> {
        return this.prisma.royaltyRule.create({ data });
    }

    /**
     * Closes a rule at a point in time.
     *
     * The ONLY mutation this table accepts. Terms are never rewritten in
     * place: an accrual posted under the old percentage has to stay
     * explainable, so a renegotiation is "close the old rule, create a new
     * one" and the entries keep pointing at the version that priced them.
     *
     * Guarded on `effectiveTo: null` so two operators closing the same rule
     * produce one update and one zero-count, rather than a silent overwrite.
     */
    async close(id: string, effectiveTo: Date): Promise<number> {
        const result = await this.prisma.royaltyRule.updateMany({
            where: { id, effectiveTo: null },
            data: { effectiveTo },
        });
        return result.count;
    }
}
