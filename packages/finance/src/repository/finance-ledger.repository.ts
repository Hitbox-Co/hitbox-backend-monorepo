import { Prisma } from '@hitbox/database';
import type { FinanceLedgerEntry, PrismaClient } from '@hitbox/database';
import type {
    ListAdjustmentsQuery,
    ListFinanceEntriesQuery,
    RevenueSummaryQuery,
} from '../dto/finance.dto';

/** Platform-side postings, adjustments, and the margin report over both. */
export class FinanceLedgerRepository {
    constructor(private readonly prisma: PrismaClient) { }

    // ── Platform ledger ─────────────────────────────────────────────────────

    /**
     * Posts a platform line, idempotently when a `postingKey` is supplied.
     *
     * Same contract as the royalty ledger's accrual: the key is UNIQUE, a
     * duplicate returns null rather than throwing, and the caller reads null as
     * "already posted". A settlement webhook redelivered by Stripe six times
     * therefore books revenue once.
     */
    async post(
        data: Prisma.FinanceLedgerEntryUncheckedCreateInput,
        tx?: Prisma.TransactionClient,
    ): Promise<FinanceLedgerEntry | null> {
        const client = tx ?? this.prisma;
        try {
            return await client.financeLedgerEntry.create({ data });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                return null;
            }
            throw error;
        }
    }

    async listEntries(
        query: ListFinanceEntriesQuery & {
            scopeFilter: Prisma.FinanceLedgerEntryWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: FinanceLedgerEntry[] }> {
        const where: Prisma.FinanceLedgerEntryWhereInput = {
            ...query.scopeFilter,
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.category ? { category: query.category } : {}),
            ...(query.direction ? { direction: query.direction } : {}),
            ...(query.currency ? { currency: query.currency } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.financeLedgerEntry.count({ where }),
            this.prisma.financeLedgerEntry.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    // ── Adjustments ─────────────────────────────────────────────────────────

    createAdjustment(
        data: Prisma.AdjustmentEntryUncheckedCreateInput,
        tx?: Prisma.TransactionClient,
    ) {
        return (tx ?? this.prisma).adjustmentEntry.create({ data });
    }

    async listAdjustments(
        query: ListAdjustmentsQuery & {
            scopeFilter: Prisma.AdjustmentEntryWhereInput;
            skip: number;
            take: number;
        },
    ) {
        const where: Prisma.AdjustmentEntryWhereInput = {
            ...query.scopeFilter,
            ...(query.targetType ? { targetType: query.targetType } : {}),
            ...(query.targetId ? { targetId: query.targetId } : {}),
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.adjustmentEntry.count({ where }),
            this.prisma.adjustmentEntry.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /** Every correction posted against one record — the traceability query. */
    adjustmentsFor(targetType: Prisma.AdjustmentEntryWhereInput['targetType'], targetId: string) {
        return this.prisma.adjustmentEntry.findMany({
            where: { targetType, targetId },
            orderBy: { createdAt: 'asc' },
        });
    }

    // ── Reporting ───────────────────────────────────────────────────────────

    /**
     * Revenue, cost and margin by currency.
     *
     * Grouped by (currency, category) in one pass. Currencies are **never**
     * summed together: there is no platform FX rate in this system, and a
     * "total revenue" that silently adds dollars to rupees is worse than no
     * total at all. The caller gets one summary row per currency.
     */
    async revenueByCategory(
        query: RevenueSummaryQuery & { scopeFilter: Prisma.FinanceLedgerEntryWhereInput },
    ) {
        const where: Prisma.FinanceLedgerEntryWhereInput = {
            ...query.scopeFilter,
            ...(query.currency ? { currency: query.currency } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const rows = await this.prisma.financeLedgerEntry.groupBy({
            by: ['currency', 'category'],
            where,
            _sum: { amount: true, costOfGoods: true, gatewayFee: true },
            _count: { _all: true },
        });

        return rows.map((row) => ({
            currency: row.currency,
            category: row.category,
            amount: row._sum.amount ?? new Prisma.Decimal(0),
            costOfGoods: row._sum.costOfGoods ?? new Prisma.Decimal(0),
            gatewayFee: row._sum.gatewayFee ?? new Prisma.Decimal(0),
            count: row._count._all,
        }));
    }

    /** Distinct orders behind the summary, for the order-count line. */
    async orderCount(
        query: RevenueSummaryQuery & { scopeFilter: Prisma.FinanceLedgerEntryWhereInput },
    ): Promise<number> {
        const rows = await this.prisma.financeLedgerEntry.groupBy({
            by: ['orderId'],
            where: {
                ...query.scopeFilter,
                orderId: { not: null },
                category: 'SALE_REVENUE',
                ...(query.currency ? { currency: query.currency } : {}),
                ...(query.from || query.to
                    ? {
                        createdAt: {
                            ...(query.from ? { gte: query.from } : {}),
                            ...(query.to ? { lt: query.to } : {}),
                        },
                    }
                    : {}),
            },
        });
        return rows.length;
    }
}
