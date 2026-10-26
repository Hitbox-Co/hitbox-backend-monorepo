import { Prisma } from '@hitbox/database';
import type { Currency, PrismaClient } from '@hitbox/database';
import type { ResolvedPeriod } from '../domain/period';

/**
 * Per-artist reporting queries, behind `ArtistInsightsAdapter`.
 *
 * Same rules as DashboardRepository: read-only, aggregated in SQL. An
 * artist's sales are the orders on drops whose `artistId` is theirs; "sold"
 * is the dashboard's definition everywhere — PAID, PROCESSING, SHIPPED,
 * DELIVERED — so a cancelled or refunded order never counts. Revenue is
 * recognised on `paidAt`.
 */

const SOLD = Prisma.sql`('PAID','PROCESSING','SHIPPED','DELIVERED')`;

type Num = bigint | number | null;
type Dec = Prisma.Decimal | null;

export class ArtistInsightsRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** Lifetime and in-window sales, one row per currency. */
    sales(artistId: string, period: ResolvedPeriod) {
        const inWindow = Prisma.sql`o."paidAt" >= ${period.from} AND o."paidAt" < ${period.to}`;
        return this.prisma.$queryRaw<{
            currency: Currency;
            orders: Num; units: Num; amount: Dec;
            p_orders: Num; p_units: Num; p_amount: Dec;
        }[]>(Prisma.sql`
            SELECT o.currency AS currency,
                   count(*)                                             AS orders,
                   COALESCE(sum(o.quantity), 0)                         AS units,
                   COALESCE(sum(o.amount), 0)                           AS amount,
                   count(*) FILTER (WHERE ${inWindow})                  AS p_orders,
                   COALESCE(sum(o.quantity) FILTER (WHERE ${inWindow}), 0) AS p_units,
                   COALESCE(sum(o.amount) FILTER (WHERE ${inWindow}), 0)   AS p_amount
            FROM "Order" o
            JOIN "Drop" d ON d.id = o."productId"
            WHERE d."artistId" = ${artistId}::uuid
              AND o.status IN ${SOLD}
              AND o."archivedAt" IS NULL
            GROUP BY o.currency
        `);
    }

    /** Units sold per bucket inside the window. */
    salesTrend(artistId: string, period: ResolvedPeriod) {
        return this.prisma.$queryRaw<{ bucket: Date; value: Num }[]>(Prisma.sql`
            SELECT date_trunc(${period.granularity}, o."paidAt") AS bucket,
                   COALESCE(sum(o.quantity), 0)                  AS value
            FROM "Order" o
            JOIN "Drop" d ON d.id = o."productId"
            WHERE d."artistId" = ${artistId}::uuid
              AND o.status IN ${SOLD}
              AND o."archivedAt" IS NULL
              AND o."paidAt" >= ${period.from} AND o."paidAt" < ${period.to}
            GROUP BY 1 ORDER BY 1
        `);
    }

    /**
     * Royalties owed to the artist, per currency. A REVERSED original drops
     * out; a clawback is a negative ADJUSTMENT row and nets off by itself.
     */
    royalties(artistId: string, period: ResolvedPeriod) {
        return this.prisma.$queryRaw<{
            currency: Currency; earned: Dec; paid: Dec; outstanding: Dec; period_earned: Dec;
        }[]>(Prisma.sql`
            SELECT rl.currency AS currency,
                   COALESCE(sum(rl.amount) FILTER (WHERE rl.status <> 'REVERSED'), 0)                      AS earned,
                   COALESCE(sum(rl.amount) FILTER (WHERE rl.status = 'PAID'), 0)                           AS paid,
                   COALESCE(sum(rl.amount) FILTER (WHERE rl.status IN ('ACCRUED','PENDING_PAYOUT')), 0)    AS outstanding,
                   COALESCE(sum(rl.amount) FILTER (WHERE rl.status <> 'REVERSED'
                        AND rl."accruedAt" >= ${period.from} AND rl."accruedAt" < ${period.to}), 0)       AS period_earned
            FROM "RoyaltyLedgerEntry" rl
            WHERE rl."payeeArtistId" = ${artistId}::uuid
            GROUP BY rl.currency
        `);
    }

    async claims(artistId: string, period: ResolvedPeriod) {
        const rows = await this.prisma.$queryRaw<{ live: Num; in_window: Num; revoked: Num }[]>(Prisma.sql`
            SELECT count(*) FILTER (WHERE c."revokedAt" IS NULL)                                AS live,
                   count(*) FILTER (WHERE c."revokedAt" IS NULL
                        AND c."claimedAt" >= ${period.from} AND c."claimedAt" < ${period.to})  AS in_window,
                   count(*) FILTER (WHERE c."revokedAt" IS NOT NULL)                            AS revoked
            FROM "SkuClaim" c
            WHERE c."artistId" = ${artistId}::uuid
        `);
        const row = rows[0];
        return { live: n(row?.live), inWindow: n(row?.in_window), revoked: n(row?.revoked) };
    }

    async followers(artistId: string, period: ResolvedPeriod) {
        const [totals, buckets] = await Promise.all([
            this.prisma.$queryRaw<{ total: Num; before: Num; in_window: Num }[]>(Prisma.sql`
                SELECT count(*)                                                    AS total,
                       count(*) FILTER (WHERE f."createdAt" < ${period.from})      AS before,
                       count(*) FILTER (WHERE f."createdAt" >= ${period.from}
                                          AND f."createdAt" < ${period.to})        AS in_window
                FROM "Follow" f
                WHERE f."artistId" = ${artistId}::uuid
            `),
            this.prisma.$queryRaw<{ bucket: Date; value: Num }[]>(Prisma.sql`
                SELECT date_trunc(${period.granularity}, f."createdAt") AS bucket, count(*) AS value
                FROM "Follow" f
                WHERE f."artistId" = ${artistId}::uuid
                  AND f."createdAt" >= ${period.from} AND f."createdAt" < ${period.to}
                GROUP BY 1 ORDER BY 1
            `),
        ]);
        const row = totals[0];
        return {
            total: n(row?.total),
            before: n(row?.before),
            inWindow: n(row?.in_window),
            buckets: buckets.map((b) => ({ bucket: b.bucket, value: n(b.value) })),
        };
    }

    /** Best-selling drops by units, all time. */
    topDrops(artistId: string, limit: number) {
        return this.prisma.$queryRaw<{
            id: string; publicCode: string | null; name: string; status: string; orders: Num; units: Num;
        }[]>(Prisma.sql`
            SELECT d.id, d."publicCode" AS "publicCode", d.name, d.status::text AS status,
                   count(o.id) AS orders, COALESCE(sum(o.quantity), 0) AS units
            FROM "Drop" d
            JOIN "Order" o ON o."productId" = d.id
                          AND o.status IN ${SOLD}
                          AND o."archivedAt" IS NULL
            WHERE d."artistId" = ${artistId}::uuid
            GROUP BY d.id, d."publicCode", d.name, d.status
            ORDER BY units DESC, d.name ASC
            LIMIT ${limit}
        `);
    }

    /** Revenue per drop and currency, for the drops already ranked. */
    revenueByDrop(dropIds: string[]) {
        if (dropIds.length === 0) return Promise.resolve([]);
        return this.prisma.$queryRaw<{ dropId: string; currency: Currency; amount: Dec }[]>(Prisma.sql`
            SELECT o."productId" AS "dropId", o.currency AS currency, COALESCE(sum(o.amount), 0) AS amount
            FROM "Order" o
            WHERE o."productId" = ANY(${dropIds}::uuid[])
              AND o.status IN ${SOLD}
              AND o."archivedAt" IS NULL
            GROUP BY o."productId", o.currency
        `);
    }

    /** Artists by units sold, all time. Archived artists are left out. */
    topArtists(limit: number, organizationId?: string) {
        return this.prisma.$queryRaw<{ artistId: string; orders: Num; units: Num }[]>(Prisma.sql`
            SELECT d."artistId" AS "artistId", count(o.id) AS orders, COALESCE(sum(o.quantity), 0) AS units
            FROM "Order" o
            JOIN "Drop" d   ON d.id = o."productId"
            JOIN "Artist" a ON a.id = d."artistId"
            WHERE o.status IN ${SOLD}
              AND o."archivedAt" IS NULL
              AND a."archivedAt" IS NULL
              ${organizationId ? Prisma.sql`AND a."organizationId" = ${organizationId}::uuid` : Prisma.empty}
            GROUP BY d."artistId"
            ORDER BY units DESC, d."artistId" ASC
            LIMIT ${limit}
        `);
    }

    revenueByArtist(artistIds: string[]) {
        if (artistIds.length === 0) return Promise.resolve([]);
        return this.prisma.$queryRaw<{ artistId: string; currency: Currency; amount: Dec }[]>(Prisma.sql`
            SELECT d."artistId" AS "artistId", o.currency AS currency, COALESCE(sum(o.amount), 0) AS amount
            FROM "Order" o
            JOIN "Drop" d ON d.id = o."productId"
            WHERE d."artistId" = ANY(${artistIds}::uuid[])
              AND o.status IN ${SOLD}
              AND o."archivedAt" IS NULL
            GROUP BY d."artistId", o.currency
        `);
    }

    // ── Payouts & tax ───────────────────────────────────────────────────────

    async payouts(artistId: string) {
        const [last, byStatus] = await Promise.all([
            this.prisma.royaltyPayout.findFirst({
                where: { payeeArtistId: artistId },
                orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
                select: {
                    id: true, publicCode: true, status: true, currency: true, amount: true,
                    scheduledAt: true, paidAt: true, failureReason: true,
                },
            }),
            this.prisma.royaltyPayout.groupBy({
                by: ['status'],
                where: { payeeArtistId: artistId },
                _count: { _all: true },
            }),
        ]);
        const counts: Record<string, number> = {};
        for (const row of byStatus) counts[row.status] = row._count._all;
        return { last, counts };
    }

    /** Paid-out totals per currency. */
    paidPayouts(artistId: string) {
        return this.prisma.royaltyPayout.groupBy({
            by: ['currency'],
            where: { payeeArtistId: artistId, status: 'PAID' },
            _sum: { amount: true },
        });
    }

    /** Accrued-not-paid royalties per currency. */
    outstandingRoyalties(artistId: string) {
        return this.prisma.royaltyLedgerEntry.groupBy({
            by: ['currency'],
            where: { payeeArtistId: artistId, status: { in: ['ACCRUED', 'PENDING_PAYOUT'] } },
            _sum: { amount: true },
        });
    }

    /** Live tax documents. Document numbers and files are deliberately not selected. */
    taxDocuments(artistId: string) {
        return this.prisma.artistTaxDocument.findMany({
            where: { artistId, status: { not: 'ARCHIVED' } },
            select: {
                id: true, documentType: true, countryCode: true, status: true,
                expiresAt: true, verifiedAt: true, backupWithholdingApplied: true,
            },
            orderBy: [{ documentType: 'asc' }, { countryCode: 'asc' }],
        });
    }
}

function n(value: Num | undefined): number {
    return Number(value ?? 0);
}
