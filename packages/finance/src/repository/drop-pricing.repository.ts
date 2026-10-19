import { Prisma } from '@hitbox/database';
import type { DropPricing, PrismaClient } from '@hitbox/database';

/**
 * The versioned COGS / sales-price entries, plus the projection onto the
 * per-market `DropPrice` rows that orders read.
 *
 * `DropPrice` is owned by the products module. This repository writes to it
 * through the shared client only to keep the active version's figures in step;
 * it never changes what that module's own API reads or validates.
 */
export class DropPricingRepository {
    constructor(private readonly prisma: PrismaClient) { }

    dropExists(dropId: string): Promise<boolean> {
        return this.prisma.drop.count({ where: { id: dropId } }).then((n) => n > 0);
    }

    list(dropId: string): Promise<DropPricing[]> {
        return this.prisma.dropPricing.findMany({
            where: { dropId },
            orderBy: { version: 'desc' },
        });
    }

    /** The version in force at `at`: started, and not yet closed. */
    findActive(
        dropId: string,
        at: Date,
        tx?: Prisma.TransactionClient,
    ): Promise<DropPricing | null> {
        return (tx ?? this.prisma).dropPricing.findFirst({
            where: {
                dropId,
                effectiveFrom: { lte: at },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
            },
            orderBy: { version: 'desc' },
        });
    }

    /**
     * The version that is still open (no `effectiveTo`), whether or not it has
     * started. Used to supersede: looking only at "in force right now" would let
     * a backdated entry slip in beside an open version and overlap it.
     */
    findOpen(dropId: string, tx: Prisma.TransactionClient): Promise<DropPricing | null> {
        return tx.dropPricing.findFirst({
            where: { dropId, effectiveTo: null },
            orderBy: { version: 'desc' },
        });
    }

    async latestVersion(dropId: string, tx: Prisma.TransactionClient): Promise<number> {
        const row = await tx.dropPricing.findFirst({
            where: { dropId },
            orderBy: { version: 'desc' },
            select: { version: true },
        });
        return row?.version ?? 0;
    }

    /** Closes the previous version. Guarded so two writers cannot both close it. */
    async closeVersion(
        id: string,
        effectiveTo: Date,
        tx: Prisma.TransactionClient,
    ): Promise<number> {
        const result = await tx.dropPricing.updateMany({
            where: { id, effectiveTo: null },
            data: { effectiveTo, status: 'DISABLED' },
        });
        return result.count;
    }

    create(
        data: Prisma.DropPricingUncheckedCreateInput,
        tx: Prisma.TransactionClient,
    ): Promise<DropPricing> {
        return tx.dropPricing.create({ data });
    }

    /** The markets this entry prices: active USD and INR markets, default first. */
    marketsByCurrency(tx: Prisma.TransactionClient) {
        return tx.market.findMany({
            where: { currency: { in: ['USD', 'INR'] }, isActive: true, archivedAt: null },
            select: { id: true, currency: true, isDefault: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
    }

    /**
     * Projects a version onto the base (variant-less) `DropPrice` row of one
     * market: closes the row currently in force and opens a new one, so the
     * per-market history mirrors the version history.
     */
    async projectToMarket(
        input: {
            id: string;
            dropId: string;
            marketId: string;
            amount: Prisma.Decimal;
            costOfGoods: Prisma.Decimal;
            effectiveFrom: Date;
            approvedById: string;
        },
        tx: Prisma.TransactionClient,
    ): Promise<void> {
        await tx.dropPrice.updateMany({
            where: {
                dropId: input.dropId,
                marketId: input.marketId,
                variantId: null,
                effectiveFrom: { lte: input.effectiveFrom },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
            },
            data: { effectiveTo: input.effectiveFrom, updatedAt: new Date() },
        });
        const now = new Date();
        await tx.dropPrice.create({
            data: {
                id: input.id,
                dropId: input.dropId,
                marketId: input.marketId,
                variantId: null,
                amount: input.amount,
                isFree: false,
                costOfGoods: input.costOfGoods,
                status: 'ACTIVE',
                effectiveFrom: input.effectiveFrom,
                approvedById: input.approvedById,
                approvedAt: now,
                createdAt: now,
                updatedAt: now,
            },
        });
    }
}
