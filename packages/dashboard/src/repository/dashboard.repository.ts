import { Prisma } from '@hitbox/database';
import type { Currency, PrismaClient } from '@hitbox/database';
import { INTERNAL_ADMIN_ROLE_NAMES } from '../domain/admin-classification';
import type { ResolvedPeriod } from '../domain/period';

/**
 * Every dashboard query. The only place in this module that touches Prisma.
 *
 * Two rules hold throughout:
 *
 *  1. **Aggregate in SQL, never in JavaScript.** `groupBy`/`count`/`$queryRaw`
 *     with `date_trunc` — never "fetch 18,000 orders and reduce them". The
 *     difference is a 2 KB result set versus 40 MB and a GC pause.
 *  2. **Every method takes the org filter explicitly.** Scope is resolved once
 *     from the caller's grants and threaded down; no method reaches for a
 *     request object or decides scope for itself.
 */

/** Null means unrestricted; an array means "these organizations only". */
export type OrgFilter = string[] | null;

export interface TrendPoint {
    date: string;
    value: number;
}

function orgWhere<T extends string>(field: T, orgIds: OrgFilter) {
    return orgIds === null ? {} : { [field]: { in: orgIds } };
}

export class DashboardRepository {
    constructor(private readonly prisma: PrismaClient) { }

    // ── Users ───────────────────────────────────────────────────────────────

    /**
     * User counts split into internal staff vs everyone else.
     *
     * The split is done in SQL with a correlated EXISTS against live role
     * assignments rather than by loading users and classifying in JS — the
     * user table is the largest in the system and this runs on every
     * dashboard load.
     */
    async userCounts(period: ResolvedPeriod): Promise<{
        total: number;
        active: number;
        inactive: number;
        newUsers: number;
        newAdmins: number;
        previousNewUsers: number;
        totalAdmins: number;
    }> {
        const adminExists = Prisma.sql`
            EXISTS (
                SELECT 1 FROM "RoleAssignment" ra
                JOIN "Role" r ON r.id = ra."roleId"
                WHERE ra."userId" = u.id
                  AND ra."revokedAt" IS NULL
                  AND r."isActive" = true
                  AND r.name IN (${Prisma.join(INTERNAL_ADMIN_ROLE_NAMES)})
            )`;

        const rows = await this.prisma.$queryRaw<
            {
                total: bigint;
                active: bigint;
                inactive: bigint;
                new_users: bigint;
                new_admins: bigint;
                prev_new_users: bigint;
                total_admins: bigint;
            }[]
        >(Prisma.sql`
            SELECT
                count(*) FILTER (WHERE NOT ${adminExists})                                              AS total,
                count(*) FILTER (WHERE NOT ${adminExists} AND u."isActive")                             AS active,
                count(*) FILTER (WHERE NOT ${adminExists} AND NOT u."isActive")                         AS inactive,
                count(*) FILTER (WHERE NOT ${adminExists}
                                   AND u."createdAt" >= ${period.from} AND u."createdAt" < ${period.to}) AS new_users,
                count(*) FILTER (WHERE ${adminExists}
                                   AND u."createdAt" >= ${period.from} AND u."createdAt" < ${period.to}) AS new_admins,
                count(*) FILTER (WHERE NOT ${adminExists}
                                   AND u."createdAt" >= ${period.previousFrom}
                                   AND u."createdAt" < ${period.previousTo})                            AS prev_new_users,
                count(*) FILTER (WHERE ${adminExists})                                                  AS total_admins
            FROM "User" u
            WHERE u."archivedAt" IS NULL
        `);

        const row = rows[0];
        return {
            total: Number(row?.total ?? 0),
            active: Number(row?.active ?? 0),
            inactive: Number(row?.inactive ?? 0),
            newUsers: Number(row?.new_users ?? 0),
            newAdmins: Number(row?.new_admins ?? 0),
            previousNewUsers: Number(row?.prev_new_users ?? 0),
            totalAdmins: Number(row?.total_admins ?? 0),
        };
    }

    /** New non-admin signups bucketed by day or month. */
    async userTrend(period: ResolvedPeriod): Promise<TrendPoint[]> {
        const rows = await this.prisma.$queryRaw<{ bucket: Date; value: bigint }[]>(Prisma.sql`
            SELECT date_trunc(${period.granularity}, u."createdAt") AS bucket, count(*) AS value
            FROM "User" u
            WHERE u."createdAt" >= ${period.from} AND u."createdAt" < ${period.to}
              AND u."archivedAt" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "RoleAssignment" ra
                JOIN "Role" r ON r.id = ra."roleId"
                WHERE ra."userId" = u.id AND ra."revokedAt" IS NULL
                  AND r.name IN (${Prisma.join(INTERNAL_ADMIN_ROLE_NAMES)})
              )
            GROUP BY 1 ORDER BY 1
        `);
        return rows.map((r) => ({ date: bucketKey(r.bucket), value: Number(r.value) }));
    }

    /** Users per market, via their preferred market (not their orders). */
    async usersByMarket(period: ResolvedPeriod): Promise<
        { marketId: string; code: string; name: string; users: number; newUsers: number }[]
    > {
        const rows = await this.prisma.$queryRaw<
            { marketId: string; code: string; name: string; users: bigint; new_users: bigint }[]
        >(Prisma.sql`
            SELECT m.id AS "marketId", m.code, m.name,
                   count(u.id)                                                                    AS users,
                   count(u.id) FILTER (WHERE u."createdAt" >= ${period.from}
                                         AND u."createdAt" < ${period.to})                        AS new_users
            FROM "Market" m
            LEFT JOIN "User" u ON u."preferredMarketId" = m.id AND u."archivedAt" IS NULL
            WHERE m."archivedAt" IS NULL
            GROUP BY m.id, m.code, m.name ORDER BY users DESC
        `);
        return rows.map((r) => ({
            marketId: r.marketId,
            code: r.code,
            name: r.name,
            users: Number(r.users),
            newUsers: Number(r.new_users),
        }));
    }

    // ── Orders ──────────────────────────────────────────────────────────────

    async orderCounts(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{
        total: number;
        newOrders: number;
        previousNewOrders: number;
        byStatus: Record<string, number>;
    }> {
        const base = { archivedAt: null, ...orgWhere('organizationId', orgIds) };

        const [total, newOrders, previousNewOrders, grouped] = await Promise.all([
            this.prisma.order.count({ where: base }),
            this.prisma.order.count({
                where: { ...base, placedAt: { gte: period.from, lt: period.to } },
            }),
            this.prisma.order.count({
                where: {
                    ...base,
                    placedAt: { gte: period.previousFrom, lt: period.previousTo },
                },
            }),
            this.prisma.order.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
        ]);

        const byStatus: Record<string, number> = {};
        for (const row of grouped) byStatus[row.status] = row._count._all;
        return { total, newOrders, previousNewOrders, byStatus };
    }

    async orderTrend(period: ResolvedPeriod, orgIds: OrgFilter): Promise<TrendPoint[]> {
        const orgClause =
            orgIds === null
                ? Prisma.empty
                : Prisma.sql`AND o."organizationId" = ANY(${orgIds}::uuid[])`;
        const rows = await this.prisma.$queryRaw<{ bucket: Date; value: bigint }[]>(Prisma.sql`
            SELECT date_trunc(${period.granularity}, o."placedAt") AS bucket, count(*) AS value
            FROM "Order" o
            WHERE o."placedAt" >= ${period.from} AND o."placedAt" < ${period.to}
              AND o."archivedAt" IS NULL ${orgClause}
            GROUP BY 1 ORDER BY 1
        `);
        return rows.map((r) => ({ date: bucketKey(r.bucket), value: Number(r.value) }));
    }

    /** Order counts per market. Money for the same slice is a separate call. */
    async ordersByMarket(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{ marketId: string; orders: number; newOrders: number }[]> {
        const base = { archivedAt: null, ...orgWhere('organizationId', orgIds) };
        const [all, fresh] = await Promise.all([
            this.prisma.order.groupBy({
                by: ['marketId'],
                where: base,
                _count: { _all: true },
            }),
            this.prisma.order.groupBy({
                by: ['marketId'],
                where: { ...base, placedAt: { gte: period.from, lt: period.to } },
                _count: { _all: true },
            }),
        ]);
        const freshByMarket = new Map(fresh.map((r) => [r.marketId, r._count._all]));
        return all
            .filter((r): r is typeof r & { marketId: string } => r.marketId !== null)
            .map((r) => ({
                marketId: r.marketId,
                orders: r._count._all,
                newOrders: freshByMarket.get(r.marketId) ?? 0,
            }));
    }

    async listOrders(input: {
        period: ResolvedPeriod;
        orgIds: OrgFilter;
        status?: string | undefined;
        marketId?: string | undefined;
        skip: number;
        take: number;
    }) {
        const where: Prisma.OrderWhereInput = {
            archivedAt: null,
            placedAt: { gte: input.period.from, lt: input.period.to },
            ...orgWhere('organizationId', input.orgIds),
            ...(input.status ? { status: input.status as Prisma.EnumOrderStatusFilter['equals'] } : {}),
            ...(input.marketId ? { marketId: input.marketId } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                orderBy: { placedAt: 'desc' },
                skip: input.skip,
                take: input.take,
                select: {
                    id: true, status: true, quantity: true, amount: true, currency: true,
                    marketId: true, organizationId: true, buyerId: true, productId: true,
                    skuId: true, placedAt: true, shippedAt: true, deliveredAt: true,
                },
            }),
        ]);
        return { total, items };
    }

    // ── Money ───────────────────────────────────────────────────────────────

    /** Gross order value in the window, by currency. */
    async grossRevenue(period: ResolvedPeriod, orgIds: OrgFilter) {
        return this.prisma.order.groupBy({
            by: ['currency'],
            where: {
                archivedAt: null,
                placedAt: { gte: period.from, lt: period.to },
                ...orgWhere('organizationId', orgIds),
            },
            _sum: { amount: true },
        });
    }

    /** Money actually collected — SUCCEEDED transactions only. */
    async collectedRevenue(period: ResolvedPeriod, orgIds: OrgFilter) {
        return this.prisma.paymentTransaction.groupBy({
            by: ['currency'],
            where: {
                status: 'SUCCEEDED',
                createdAt: { gte: period.from, lt: period.to },
                ...(orgIds === null ? {} : { order: { organizationId: { in: orgIds } } }),
            },
            _sum: { amount: true },
        });
    }

    /**
     * Refunded money — PROCESSED only. `REQUESTED`/`APPROVED` are pipeline
     * states; counting them as refunded overstates money returned.
     * `RefundRequest` has no currency column, so it is taken from the order.
     */
    async refundedAmount(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{ currency: Currency; amount: Prisma.Decimal }[]> {
        const rows = await this.prisma.$queryRaw<{ currency: Currency; amount: Prisma.Decimal }[]>(
            Prisma.sql`
            SELECT o.currency AS currency, COALESCE(sum(rr.amount), 0) AS amount
            FROM "RefundRequest" rr
            JOIN "Order" o ON o.id = rr."orderId"
            WHERE rr.status = 'PROCESSED'
              AND rr."updatedAt" >= ${period.from} AND rr."updatedAt" < ${period.to}
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND o."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY o.currency
        `,
        );
        return rows;
    }

    /**
     * Cost of goods and gateway fees from the finance ledger.
     *
     * `CREDIT` minus `DEBIT`, so an `ADJUSTMENT` posted to correct an earlier
     * entry nets against it rather than being double-counted or dropped.
     */
    async financeLedgerTotals(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{ currency: Currency; costOfGoods: Prisma.Decimal; gatewayFee: Prisma.Decimal }[]> {
        return this.prisma.$queryRaw(Prisma.sql`
            SELECT f.currency AS currency,
                   COALESCE(sum(CASE WHEN f.direction = 'CREDIT' THEN f."costOfGoods" ELSE -f."costOfGoods" END), 0) AS "costOfGoods",
                   COALESCE(sum(CASE WHEN f.direction = 'CREDIT' THEN f."gatewayFee"  ELSE -f."gatewayFee"  END), 0) AS "gatewayFee"
            FROM "FinanceLedgerEntry" f
            LEFT JOIN "Order" o ON o.id = f."orderId"
            WHERE f."createdAt" >= ${period.from} AND f."createdAt" < ${period.to}
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND o."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY f.currency
        `);
    }

    /** Royalties owed. ADJUSTMENT rows net against their ORIGINAL. */
    async royaltyTotals(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{ currency: Currency; amount: Prisma.Decimal }[]> {
        return this.prisma.$queryRaw(Prisma.sql`
            SELECT rl.currency AS currency, COALESCE(sum(rl.amount), 0) AS amount
            FROM "RoyaltyLedgerEntry" rl
            JOIN "Order" o ON o.id = rl."orderId"
            WHERE rl."createdAt" >= ${period.from} AND rl."createdAt" < ${period.to}
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND o."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY rl.currency
        `);
    }

    async paymentCounts(period: ResolvedPeriod, orgIds: OrgFilter) {
        const where: Prisma.PaymentTransactionWhereInput = {
            createdAt: { gte: period.from, lt: period.to },
            ...(orgIds === null ? {} : { order: { organizationId: { in: orgIds } } }),
        };
        const [byStatus, needsReview, amounts] = await Promise.all([
            this.prisma.paymentTransaction.groupBy({
                by: ['status'], where, _count: { _all: true },
            }),
            this.prisma.paymentTransaction.count({ where: { ...where, needsReview: true } }),
            this.prisma.paymentTransaction.groupBy({
                by: ['currency'], where: { ...where, status: 'SUCCEEDED' }, _sum: { amount: true },
            }),
        ]);
        const counts: Record<string, number> = {};
        for (const row of byStatus) counts[row.status] = row._count._all;
        return { counts, needsReview, amounts };
    }

    async refundCounts(period: ResolvedPeriod, orgIds: OrgFilter) {
        const where: Prisma.RefundRequestWhereInput = {
            createdAt: { gte: period.from, lt: period.to },
            ...(orgIds === null ? {} : { order: { organizationId: { in: orgIds } } }),
        };
        const grouped = await this.prisma.refundRequest.groupBy({
            by: ['status'], where, _count: { _all: true },
        });
        const counts: Record<string, number> = {};
        for (const row of grouped) counts[row.status] = row._count._all;
        return counts;
    }

    /** Revenue and refunds per market, for the markets section. */
    async moneyByMarket(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<{ marketId: string; currency: Currency; revenue: Prisma.Decimal }[]> {
        return this.prisma.$queryRaw(Prisma.sql`
            SELECT o."marketId" AS "marketId", o.currency AS currency, COALESCE(sum(o.amount), 0) AS revenue
            FROM "Order" o
            WHERE o."placedAt" >= ${period.from} AND o."placedAt" < ${period.to}
              AND o."archivedAt" IS NULL AND o."marketId" IS NOT NULL
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND o."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY o."marketId", o.currency
        `);
    }

    async markets() {
        return this.prisma.market.findMany({
            where: { archivedAt: null },
            select: { id: true, code: true, name: true, currency: true, isDefault: true },
            orderBy: { code: 'asc' },
        });
    }

    // ── Products / drops ────────────────────────────────────────────────────

    async productCounts(period: ResolvedPeriod, orgIds: OrgFilter) {
        const base = { archivedAt: null, ...orgWhere('organizationId', orgIds) };
        const [grouped, total, newProducts] = await Promise.all([
            this.prisma.product.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
            this.prisma.product.count({ where: base }),
            this.prisma.product.count({
                where: { ...base, createdAt: { gte: period.from, lt: period.to } },
            }),
        ]);
        const byStatus: Record<string, number> = {};
        for (const row of grouped) byStatus[row.status] = row._count._all;
        return { byStatus, total, newProducts };
    }

    async listProducts(input: {
        orgIds: OrgFilter;
        status?: string | undefined;
        skip: number;
        take: number;
    }) {
        const where: Prisma.ProductWhereInput = {
            archivedAt: null,
            ...orgWhere('organizationId', input.orgIds),
            ...(input.status ? { status: input.status as Prisma.EnumDropStatusFilter['equals'] } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.product.count({ where }),
            this.prisma.product.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    id: true, groupCode: true, name: true, status: true, totalSupply: true,
                    complianceStatus: true, isAgeSpecific: true, minimumAge: true,
                    organizationId: true, artistId: true, publishedAt: true, createdAt: true,
                },
            }),
        ]);
        return { total, items };
    }

    /**
     * Inventory per product: supply, reserved, committed, claimed, sold.
     *
     * One grouped query rather than a per-SKU scan — the SKU table has one row
     * per manufactured item, so iterating it from the API layer does not scale
     * past the first real drop.
     */
    async inventory(
        orgIds: OrgFilter,
        limit: number,
    ): Promise<
        {
            productId: string; name: string; totalSupply: number;
            reserved: number; committed: number; claimed: number;
            sold: number; available: number;
        }[]
    > {
        const rows = await this.prisma.$queryRaw<
            {
                productId: string; name: string; totalSupply: number;
                reserved: bigint; committed: bigint; claimed: bigint; sold: bigint;
            }[]
        >(Prisma.sql`
            SELECT p.id AS "productId", p.name, p."totalSupply",
                   count(DISTINCT ir.id) FILTER (WHERE ir.status = 'HELD')       AS reserved,
                   count(DISTINCT ir.id) FILTER (WHERE ir.status = 'COMMITTED')  AS committed,
                   count(DISTINCT s.id)  FILTER (WHERE s."claimedStatus" = 'CLAIMED') AS claimed,
                   count(DISTINCT o.id)  FILTER (WHERE o."skuId" IS NOT NULL
                        AND o.status IN ('PAID','PROCESSING','SHIPPED','DELIVERED'))  AS sold
            FROM "Product" p
            LEFT JOIN "Sku" s  ON s."productId" = p.id
            LEFT JOIN "InventoryReservation" ir ON ir."skuId" = s.id
            LEFT JOIN "Order" o ON o."productId" = p.id
            WHERE p."archivedAt" IS NULL
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND p."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY p.id, p.name, p."totalSupply"
            ORDER BY p."createdAt" DESC
            LIMIT ${limit}
        `);
        // Postgres count() comes back as bigint, which JSON.stringify cannot
        // serialise — convert here rather than leaking it into the response.
        return rows.map((r) => {
            const reserved = Number(r.reserved);
            const committed = Number(r.committed);
            const claimed = Number(r.claimed);
            return {
                productId: r.productId,
                name: r.name,
                totalSupply: r.totalSupply,
                reserved,
                committed,
                claimed,
                sold: Number(r.sold),
                available: Math.max(0, r.totalSupply - reserved - committed - claimed),
            };
        });
    }

    // ── Release approvals ───────────────────────────────────────────────────

    async listReleaseApprovals(input: {
        orgIds: OrgFilter;
        status?: string | undefined;
        skip: number;
        take: number;
    }) {
        const where: Prisma.ReleaseApprovalWhereInput = {
            ...(input.status
                ? { status: input.status as Prisma.EnumApprovalStatusFilter['equals'] }
                : {}),
            ...(input.orgIds === null ? {} : { product: { organizationId: { in: input.orgIds } } }),
        };
        const [total, items] = await Promise.all([
            this.prisma.releaseApproval.count({ where }),
            this.prisma.releaseApproval.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    id: true, productId: true, status: true, version: true, comment: true,
                    complianceStatus: true, oddsDisclosureRef: true, decidedAt: true,
                    createdAt: true,
                    product: {
                        select: { name: true, isAgeSpecific: true, minimumAge: true, status: true },
                    },
                },
            }),
        ]);
        return { total, items };
    }

    // ── Provenance / anti-fraud ─────────────────────────────────────────────

    async provenanceSummary(orgIds: OrgFilter) {
        const skuWhere: Prisma.SkuWhereInput =
            orgIds === null ? {} : { product: { organizationId: { in: orgIds } } };
        const [byClaimed, byLifecycle, resaleBlocked, tampered, openCases] = await Promise.all([
            this.prisma.sku.groupBy({ by: ['claimedStatus'], where: skuWhere, _count: { _all: true } }),
            this.prisma.sku.groupBy({ by: ['tagLifecycleState'], where: skuWhere, _count: { _all: true } }),
            this.prisma.sku.count({ where: { ...skuWhere, resaleBlocked: true } }),
            this.prisma.sku.count({ where: { ...skuWhere, tamperStatus: { not: null } } }),
            this.prisma.supportCase.groupBy({
                by: ['status'], where: {}, _count: { _all: true },
            }),
        ]);
        const claimed: Record<string, number> = {};
        for (const r of byClaimed) claimed[r.claimedStatus] = r._count._all;
        const lifecycle: Record<string, number> = {};
        for (const r of byLifecycle) lifecycle[r.tagLifecycleState] = r._count._all;
        const cases: Record<string, number> = {};
        for (const r of openCases) cases[r.status] = r._count._all;
        return { claimed, lifecycle, resaleBlocked, tampered, cases };
    }

    async listSupportCases(input: {
        caseType?: string | undefined;
        status?: string | undefined;
        skip: number;
        take: number;
    }) {
        const where: Prisma.SupportCaseWhereInput = {
            ...(input.caseType
                ? { caseType: input.caseType as Prisma.EnumSupportCaseTypeFilter['equals'] }
                : {}),
            ...(input.status
                ? { status: input.status as Prisma.EnumSupportCaseStatusFilter['equals'] }
                : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.supportCase.count({ where }),
            this.prisma.supportCase.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    id: true, caseType: true, status: true, tagId: true, skuId: true,
                    reporterId: true, description: true, resolvedAt: true, createdAt: true,
                    sku: { select: { tagLifecycleState: true, tamperStatus: true, claimedStatus: true } },
                },
            }),
        ]);
        return { total, items };
    }

    // ── Content ─────────────────────────────────────────────────────────────

    async contentSummary(period: ResolvedPeriod) {
        const [totalBundles, activeBundles, newBundles, unlocks, accessAgg] = await Promise.all([
            this.prisma.contentBundle.count({ where: { archivedAt: null } }),
            this.prisma.contentBundle.count({ where: { archivedAt: null, isActive: true } }),
            this.prisma.contentBundle.count({
                where: { archivedAt: null, createdAt: { gte: period.from, lt: period.to } },
            }),
            this.prisma.contentUnlock.count({
                where: { grantedAt: { gte: period.from, lt: period.to } },
            }),
            this.prisma.contentUnlock.aggregate({ _avg: { accessCount: true } }),
        ]);
        return {
            totalBundles, activeBundles, newBundles,
            unlocksThisPeriod: unlocks,
            avgAccessCount: Math.round((accessAgg._avg.accessCount ?? 0) * 10) / 10,
        };
    }

    // ── Artists ─────────────────────────────────────────────────────────────

    async artistSummary(period: ResolvedPeriod, orgIds: OrgFilter) {
        const base = { archivedAt: null, ...orgWhere('organizationId', orgIds) };
        const [total, active, fresh, isPublic] = await Promise.all([
            this.prisma.artist.count({ where: base }),
            this.prisma.artist.count({ where: { ...base, isActive: true } }),
            this.prisma.artist.count({
                where: { ...base, createdAt: { gte: period.from, lt: period.to } },
            }),
            this.prisma.artist.count({ where: { ...base, isPublic: true } }),
        ]);
        return { total, active, new: fresh, public: isPublic };
    }

    // ── Operations ──────────────────────────────────────────────────────────

    async operations(orgIds: OrgFilter) {
        const base = { archivedAt: null, ...orgWhere('organizationId', orgIds) };
        const [pendingPayment, processing, shipped, delivered, refundsAwaiting, paymentsNeedingReview] =
            await Promise.all([
                this.prisma.order.count({ where: { ...base, status: 'PENDING_PAYMENT' } }),
                this.prisma.order.count({ where: { ...base, status: 'PROCESSING' } }),
                this.prisma.order.count({ where: { ...base, status: 'SHIPPED' } }),
                this.prisma.order.count({ where: { ...base, status: 'DELIVERED' } }),
                this.prisma.refundRequest.count({
                    where: {
                        status: { in: ['REQUESTED', 'AWAITING_RETURN', 'APPROVED'] },
                        ...(orgIds === null ? {} : { order: { organizationId: { in: orgIds } } }),
                    },
                }),
                this.prisma.paymentTransaction.count({
                    where: {
                        needsReview: true,
                        ...(orgIds === null ? {} : { order: { organizationId: { in: orgIds } } }),
                    },
                }),
            ]);
        return {
            pendingPayment, processing, shipped, delivered,
            // PAID but not yet shipped.
            awaitingShipment: await this.prisma.order.count({ where: { ...base, status: 'PAID' } }),
            refundsAwaiting, paymentsNeedingReview,
        };
    }

    // ── Activity (audit) ────────────────────────────────────────────────────

    async listActivity(input: {
        period: ResolvedPeriod;
        orgIds: OrgFilter;
        severity?: string | undefined;
        skip: number;
        take: number;
    }) {
        const where: Prisma.AuditEventWhereInput = {
            occurredAt: { gte: input.period.from, lt: input.period.to },
            ...(input.severity
                ? { severity: input.severity as Prisma.EnumAuditSeverityFilter['equals'] }
                : {}),
            ...(input.orgIds === null ? {} : { organizationId: { in: input.orgIds } }),
        };
        const [total, items] = await Promise.all([
            this.prisma.auditEvent.count({ where }),
            this.prisma.auditEvent.findMany({
                where, orderBy: { occurredAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    eventId: true, occurredAt: true, eventType: true, actorType: true,
                    actorId: true, actorRoleSnapshot: true, organizationId: true,
                    resourceType: true, resourceId: true, actionResult: true, severity: true,
                    correlationId: true,
                },
            }),
        ]);
        return { total, items };
    }

    // ── Supply ──────────────────────────────────────────────────────────────

    async listSupplyBatches(input: { vendorId?: string | undefined; skip: number; take: number }) {
        const where: Prisma.SupplyBatchWhereInput = input.vendorId
            ? { vendorId: input.vendorId }
            : {};
        const [total, items, vendors] = await Promise.all([
            this.prisma.supplyBatch.count({ where }),
            this.prisma.supplyBatch.findMany({
                where, orderBy: { receivedAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    id: true, vendorId: true, itemType: true, quantity: true, batchRef: true,
                    receivedAt: true, notes: true,
                    vendor: { select: { name: true, vendorType: true } },
                },
            }),
            this.prisma.vendor.count({ where: { isActive: true, archivedAt: null } }),
        ]);
        return { total, items, activeVendors: vendors };
    }

    // ── Resale ──────────────────────────────────────────────────────────────

    async listResale(input: { status?: string | undefined; skip: number; take: number }) {
        const where: Prisma.ResaleListingWhereInput = input.status
            ? { status: input.status as Prisma.EnumResaleStatusFilter['equals'] }
            : {};
        const [total, items, byStatus] = await Promise.all([
            this.prisma.resaleListing.count({ where }),
            this.prisma.resaleListing.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: input.skip, take: input.take,
                select: {
                    id: true, skuId: true, sellerId: true, price: true, currency: true,
                    status: true, createdAt: true,
                },
            }),
            this.prisma.resaleListing.groupBy({ by: ['status'], _count: { _all: true } }),
        ]);
        const counts: Record<string, number> = {};
        for (const r of byStatus) counts[r.status] = r._count._all;
        return { total, items, counts };
    }

    // ── Organizations & gateway config ──────────────────────────────────────

    async organizationSummary(orgIds: OrgFilter) {
        const where: Prisma.OrganizationWhereInput = {
            archivedAt: null,
            ...(orgIds === null ? {} : { id: { in: orgIds } }),
        };
        const [total, byType] = await Promise.all([
            this.prisma.organization.count({ where }),
            this.prisma.organization.groupBy({ by: ['type'], where, _count: { _all: true } }),
        ]);
        const counts: Record<string, number> = {};
        for (const r of byType) counts[r.type] = r._count._all;
        return { total, byType: counts };
    }

    /**
     * Gateway configuration, **without** `credentialsRef`.
     *
     * That column is a pointer into the secrets manager. It is excluded at the
     * query level rather than deleted from the response later, so no future
     * refactor of the serialiser can leak it by accident.
     */
    async gatewayConfigs(orgIds: OrgFilter) {
        return this.prisma.paymentGatewayConfig.findMany({
            where: orgIds === null ? {} : { organizationId: { in: orgIds } },
            select: {
                id: true, scope: true, gateway: true, isDefault: true, status: true,
                organizationId: true, createdAt: true, updatedAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    // ── Demand signals ──────────────────────────────────────────────────────

    async demandSignals(
        orgIds: OrgFilter,
        limit: number,
    ): Promise<{ productId: string; name: string; wishlists: number; follows: number }[]> {
        const rows = await this.prisma.$queryRaw<
            { productId: string; name: string; wishlists: bigint; follows: bigint }[]
        >(Prisma.sql`
            SELECT p.id AS "productId", p.name,
                   count(DISTINCT w.id) AS wishlists,
                   count(DISTINCT f.id) AS follows
            FROM "Product" p
            LEFT JOIN "WishlistItem" w ON w."productId" = p.id
            LEFT JOIN "Follow" f ON f."artistId" = p."artistId"
            WHERE p."archivedAt" IS NULL AND p.status IN ('PUBLISHED','ACTIVE')
              ${orgIds === null ? Prisma.empty : Prisma.sql`AND p."organizationId" = ANY(${orgIds}::uuid[])`}
            GROUP BY p.id, p.name
            ORDER BY wishlists DESC
            LIMIT ${limit}
        `);
        return rows.map((r) => ({
            productId: r.productId,
            name: r.name,
            wishlists: Number(r.wishlists),
            follows: Number(r.follows),
        }));
    }
}

/** `2026-08-01T00:00:00Z` -> `2026-08-01`. */
function bucketKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}
