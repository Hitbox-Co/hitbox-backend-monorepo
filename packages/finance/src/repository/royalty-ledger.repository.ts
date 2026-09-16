import { Prisma } from '@hitbox/database';
import type { PrismaClient, RoyaltyLedgerEntry } from '@hitbox/database';
import type { ListRoyaltyEntriesQuery } from '../dto/finance.dto';

const entrySelect = {
    id: true,
    orderId: true,
    ruleId: true,
    skuId: true,
    claimId: true,
    accrualKey: true,
    payeeType: true,
    payeeArtistId: true,
    payeeOrganizationId: true,
    basis: true,
    percentage: true,
    grossRevenue: true,
    costOfGoods: true,
    netProfit: true,
    amount: true,
    currency: true,
    entryType: true,
    status: true,
    adjustsEntryId: true,
    payoutId: true,
    accruedAt: true,
    paidAt: true,
    createdAt: true,
    // Resolved at the database so a page of 20 entries does not become 20
    // extra lookups for names the screen always shows.
    payeeArtist: { select: { id: true, name: true } },
    payeeOrganization: { select: { id: true, name: true } },
} satisfies Prisma.RoyaltyLedgerEntrySelect;

export type RoyaltyEntryRow = Prisma.RoyaltyLedgerEntryGetPayload<{
    select: typeof entrySelect;
}>;

/** A payee's balance in one currency, straight out of a grouped aggregate. */
export interface PayeeBalanceRow {
    payeeType: string;
    payeeArtistId: string | null;
    payeeOrganizationId: string | null;
    currency: string;
    status: string;
    total: Prisma.Decimal;
    entryCount: number;
}

export class RoyaltyLedgerRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<RoyaltyEntryRow | null> {
        return this.prisma.royaltyLedgerEntry.findUnique({
            where: { id },
            select: entrySelect,
        });
    }

    findByAccrualKey(accrualKey: string): Promise<RoyaltyEntryRow | null> {
        return this.prisma.royaltyLedgerEntry.findUnique({
            where: { accrualKey },
            select: entrySelect,
        });
    }

    /**
     * Writes one accrual.
     *
     * `skipDuplicates` is not available on `create`, so the unique violation on
     * `accrualKey` is caught and turned into "already accrued". That is the
     * idempotency guarantee the design document asks for, enforced by the
     * database rather than by a read-then-write that two concurrent webhook
     * deliveries would both pass.
     */
    async createEntry(
        data: Prisma.RoyaltyLedgerEntryUncheckedCreateInput,
        tx?: Prisma.TransactionClient,
    ): Promise<RoyaltyLedgerEntry | null> {
        const client = tx ?? this.prisma;
        try {
            return await client.royaltyLedgerEntry.create({ data });
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

    async list(
        query: ListRoyaltyEntriesQuery & {
            /** Applied unconditionally by the service from the caller's grant. */
            scopeFilter: Prisma.RoyaltyLedgerEntryWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: RoyaltyEntryRow[] }> {
        const where: Prisma.RoyaltyLedgerEntryWhereInput = {
            ...query.scopeFilter,
            ...(query.status ? { status: query.status } : {}),
            ...(query.entryType ? { entryType: query.entryType } : {}),
            ...(query.currency ? { currency: query.currency } : {}),
            ...(query.artistId ? { payeeArtistId: query.artistId } : {}),
            ...(query.organizationId ? { payeeOrganizationId: query.organizationId } : {}),
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.payoutId ? { payoutId: query.payoutId } : {}),
            ...(query.from || query.to
                ? {
                    accruedAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.royaltyLedgerEntry.count({ where }),
            this.prisma.royaltyLedgerEntry.findMany({
                where,
                select: entrySelect,
                orderBy: { accruedAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /**
     * Balances, grouped by payee × currency × status.
     *
     * One grouped aggregate rather than four filtered sums: the payout sweep
     * and the artist's "what am I owed" screen ask the same question, and a
     * balance assembled from four separate queries can be internally
     * inconsistent if an entry changes status between them.
     */
    async balances(
        where: Prisma.RoyaltyLedgerEntryWhereInput,
    ): Promise<PayeeBalanceRow[]> {
        const rows = await this.prisma.royaltyLedgerEntry.groupBy({
            by: ['payeeType', 'payeeArtistId', 'payeeOrganizationId', 'currency', 'status'],
            where,
            _sum: { amount: true },
            _count: { _all: true },
        });

        return rows.map((row) => ({
            payeeType: row.payeeType,
            payeeArtistId: row.payeeArtistId,
            payeeOrganizationId: row.payeeOrganizationId,
            currency: row.currency,
            status: row.status,
            total: row._sum.amount ?? new Prisma.Decimal(0),
            entryCount: row._count._all,
        }));
    }

    /** Every ACCRUED entry for one payee in one currency, oldest first. */
    eligibleEntries(filter: {
        payeeArtistId: string | null;
        payeeOrganizationId: string | null;
        currency: Prisma.RoyaltyLedgerEntryWhereInput['currency'];
    }): Promise<RoyaltyEntryRow[]> {
        return this.prisma.royaltyLedgerEntry.findMany({
            where: {
                status: 'ACCRUED',
                payoutId: null,
                currency: filter.currency,
                ...(filter.payeeArtistId ? { payeeArtistId: filter.payeeArtistId } : {}),
                ...(filter.payeeOrganizationId
                    ? { payeeOrganizationId: filter.payeeOrganizationId }
                    : {}),
            },
            select: entrySelect,
            orderBy: { accruedAt: 'asc' },
        });
    }

    /**
     * Attaches a set of entries to a payout batch.
     *
     * Guarded on `status: 'ACCRUED', payoutId: null`, so an entry that was
     * reversed or swept into another batch between the read and the write is
     * simply not included — the caller compares the returned count against
     * what it expected and aborts the batch if they disagree.
     */
    async attachToPayout(
        entryIds: string[],
        payoutId: string,
        tx: Prisma.TransactionClient,
    ): Promise<number> {
        const result = await tx.royaltyLedgerEntry.updateMany({
            where: { id: { in: entryIds }, status: 'ACCRUED', payoutId: null },
            data: { status: 'PENDING_PAYOUT', payoutId },
        });
        return result.count;
    }

    async markBatchPaid(
        payoutId: string,
        paidAt: Date,
        tx: Prisma.TransactionClient,
    ): Promise<number> {
        const result = await tx.royaltyLedgerEntry.updateMany({
            where: { payoutId, status: 'PENDING_PAYOUT' },
            data: { status: 'PAID', paidAt },
        });
        return result.count;
    }

    /**
     * Detaches entries from a failed batch so they can be swept again.
     * The entries are untouched otherwise — they were never paid.
     */
    async releaseBatch(payoutId: string, tx: Prisma.TransactionClient): Promise<number> {
        const result = await tx.royaltyLedgerEntry.updateMany({
            where: { payoutId, status: 'PENDING_PAYOUT' },
            data: { status: 'ACCRUED', payoutId: null },
        });
        return result.count;
    }

    /**
     * Marks an original entry REVERSED.
     *
     * The row keeps its amount: a reversed entry is not a zeroed entry. The
     * money is cancelled by the *adjustment* row that accompanies it, and a
     * balance is the sum of both — which is what makes the correction visible
     * in the trail instead of looking like the sale never happened.
     *
     * Refuses an entry that is already PAID: money that has left the platform
     * is recovered by a new negative accrual against future earnings, not by
     * rewriting a settled payout.
     */
    async markReversed(
        entryId: string,
        tx: Prisma.TransactionClient,
    ): Promise<number> {
        const result = await tx.royaltyLedgerEntry.updateMany({
            where: { id: entryId, status: { in: ['ACCRUED', 'PENDING_PAYOUT'] } },
            data: { status: 'REVERSED', payoutId: null },
        });
        return result.count;
    }

    /** Entries accrued against one order — the refund path's starting point. */
    findByOrder(orderId: string): Promise<RoyaltyEntryRow[]> {
        return this.prisma.royaltyLedgerEntry.findMany({
            where: { orderId },
            select: entrySelect,
            orderBy: { accruedAt: 'asc' },
        });
    }

    /** Entries accrued against one claim — the claim-revocation path's. */
    findByClaim(claimId: string): Promise<RoyaltyEntryRow[]> {
        return this.prisma.royaltyLedgerEntry.findMany({
            where: { claimId },
            select: entrySelect,
            orderBy: { accruedAt: 'asc' },
        });
    }

    /** Resolves a user to the artist profile they own, for OWN-scoped reads. */
    async artistIdForUser(userId: string): Promise<string | null> {
        const artist = await this.prisma.artist.findFirst({
            where: { userId },
            select: { id: true },
        });
        return artist?.id ?? null;
    }
}
