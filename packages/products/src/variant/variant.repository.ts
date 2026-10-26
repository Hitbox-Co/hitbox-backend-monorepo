import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@hitbox/database';
import type { ProductCache } from '../cache/product-cache';
import { dropTypeInclude } from '../drop-type/drop-type.repository';
import type { ResolvedOption } from '../drop-type/rules';

/**
 * Persistence for a drop's variants. Every write invalidates the drop's
 * cached catalog entry, because variants are part of the product response.
 */
export const variantInclude = {
    options: { orderBy: { position: 'asc' } },
    _count: { select: { skus: true } },
} satisfies Prisma.DropVariantInclude;

export type VariantRow = Prisma.DropVariantGetPayload<{ include: typeof variantInclude }>;

const dropForVariantsSelect = {
    id: true,
    groupCode: true,
    status: true,
    totalSupply: true,
    archivedAt: true,
    dropTypeId: true,
    dropType: { include: dropTypeInclude },
} satisfies Prisma.DropSelect;

export type DropForVariants = Prisma.DropGetPayload<{ select: typeof dropForVariantsSelect }>;

/** One variant ready to insert — every derived field already computed. */
export interface NewVariant {
    variantCode: string;
    label: string;
    optionName: string;
    optionValue: string;
    optionsKey: string;
    position: number;
    totalSupply: number | null;
    options: ResolvedOption[];
}

export class VariantRepository {
    constructor(
        private readonly prisma: PrismaClient,
        private readonly cache: ProductCache,
    ) { }

    findDrop(dropId: string): Promise<DropForVariants | null> {
        return this.prisma.drop.findUnique({ where: { id: dropId }, select: dropForVariantsSelect });
    }

    list(dropId: string, includeArchived: boolean): Promise<VariantRow[]> {
        return this.prisma.dropVariant.findMany({
            where: { productId: dropId, ...(includeArchived ? {} : { archivedAt: null }) },
            include: variantInclude,
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
    }

    find(dropId: string, variantId: string): Promise<VariantRow | null> {
        return this.prisma.dropVariant.findFirst({
            where: { id: variantId, productId: dropId },
            include: variantInclude,
        });
    }

    /** Variants of this drop with any of these keys — archived included. */
    findByKeys(dropId: string, keys: string[]): Promise<VariantRow[]> {
        if (keys.length === 0) return Promise.resolve([]);
        return this.prisma.dropVariant.findMany({
            where: { productId: dropId, optionsKey: { in: keys } },
            include: variantInclude,
        });
    }

    /** Which of these codes are already taken anywhere on the platform. */
    async takenCodes(codes: string[]): Promise<Set<string>> {
        if (codes.length === 0) return new Set();
        const rows = await this.prisma.dropVariant.findMany({
            where: { variantCode: { in: codes } },
            select: { variantCode: true },
        });
        return new Set(rows.map((row) => row.variantCode));
    }

    /** Any variant at all, archived included — a drop's type locks once one exists. */
    async hasAny(dropId: string): Promise<boolean> {
        return (await this.prisma.dropVariant.count({ where: { productId: dropId } })) > 0;
    }

    countActive(dropId: string): Promise<number> {
        return this.prisma.dropVariant.count({
            where: { productId: dropId, archivedAt: null, isActive: true },
        });
    }

    maxPosition(dropId: string): Promise<number> {
        return this.prisma.dropVariant
            .aggregate({ where: { productId: dropId }, _max: { position: true } })
            .then((r) => r._max.position ?? -1);
    }

    /** Sum of capped variants' supply, optionally leaving one variant out. */
    async cappedSupply(dropId: string, excludeVariantId?: string): Promise<number> {
        const result = await this.prisma.dropVariant.aggregate({
            where: {
                productId: dropId,
                archivedAt: null,
                ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}),
            },
            _sum: { totalSupply: true },
        });
        return result._sum.totalSupply ?? 0;
    }

    /**
     * Inserts the variants and their option rows, revives any archived
     * matches, and records the type version they were validated against —
     * one transaction, so a failure leaves nothing half-written.
     */
    async createMany(
        drop: { id: string; groupCode: string },
        dropTypeVersion: number,
        variants: NewVariant[],
        reviveIds: string[],
    ): Promise<VariantRow[]> {
        const ids: string[] = [];
        await this.prisma.$transaction(
            async (tx) => {
                const now = new Date();
                for (const variant of variants) {
                    const id = randomUUID();
                    ids.push(id);
                    await tx.dropVariant.create({
                        data: {
                            id,
                            drop: { connect: { id: drop.id } },
                            variantCode: variant.variantCode,
                            label: variant.label,
                            optionName: variant.optionName,
                            optionValue: variant.optionValue,
                            optionsKey: variant.optionsKey,
                            position: variant.position,
                            totalSupply: variant.totalSupply,
                            isActive: true,
                            createdAt: now,
                            updatedAt: now,
                            options: {
                                create: variant.options.map((option) => ({
                                    id: randomUUID(),
                                    dimensionCode: option.dimensionCode,
                                    dimensionLabel: option.dimensionLabel,
                                    valueCode: option.valueCode,
                                    valueLabel: option.valueLabel,
                                    hexCode: option.hexCode,
                                    position: option.position,
                                    createdAt: now,
                                })),
                            },
                        },
                    });
                }
                if (reviveIds.length > 0) {
                    await tx.dropVariant.updateMany({
                        where: { id: { in: reviveIds }, productId: drop.id },
                        data: { archivedAt: null, isActive: true, updatedAt: now },
                    });
                    ids.push(...reviveIds);
                }
                await tx.drop.update({
                    where: { id: drop.id },
                    data: { dropTypeVersion, updatedAt: now },
                });
            },
            { maxWait: 10_000, timeout: 20_000 },
        );
        await this.invalidate(drop);
        return this.prisma.dropVariant.findMany({
            where: { id: { in: ids } },
            include: variantInclude,
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
    }

    async update(
        drop: { id: string; groupCode: string },
        variantId: string,
        data: Prisma.DropVariantUpdateInput,
    ): Promise<VariantRow> {
        const row = await this.prisma.dropVariant.update({
            where: { id: variantId },
            data: { ...data, updatedAt: new Date() },
            include: variantInclude,
        });
        await this.invalidate(drop);
        return row;
    }

    /** What still points at a variant. Any of these means archive, not delete. */
    async references(variantId: string): Promise<{ skus: number; prices: number; orders: number; wishlists: number }> {
        const counts = await this.prisma.dropVariant.findUniqueOrThrow({
            where: { id: variantId },
            select: { _count: { select: { skus: true, dropPrices: true, orders: true, wishlistItems: true } } },
        });
        return {
            skus: counts._count.skus,
            prices: counts._count.dropPrices,
            orders: counts._count.orders,
            wishlists: counts._count.wishlistItems,
        };
    }

    /** Hard delete; option rows cascade. Only for a variant nothing references. */
    async delete(drop: { id: string; groupCode: string }, variantId: string): Promise<void> {
        await this.prisma.dropVariant.delete({ where: { id: variantId } });
        await this.invalidate(drop);
    }

    async archive(drop: { id: string; groupCode: string }, variantId: string): Promise<VariantRow> {
        const now = new Date();
        return this.update(drop, variantId, { archivedAt: now, isActive: false });
    }

    // ── For the mint / submit policy ────────────────────────────────────────

    findForPolicy(dropId: string) {
        return this.prisma.drop.findUnique({
            where: { id: dropId },
            select: { id: true, dropType: { select: { code: true, variantMode: true } } },
        });
    }

    findVariantForMint(variantId: string) {
        return this.prisma.dropVariant.findUnique({
            where: { id: variantId },
            select: {
                id: true,
                productId: true,
                variantCode: true,
                totalSupply: true,
                isActive: true,
                archivedAt: true,
                _count: { select: { skus: true } },
            },
        });
    }

    private async invalidate(drop: { id: string; groupCode: string }): Promise<void> {
        await Promise.all([this.cache.invalidateEntity(drop.id, drop.groupCode), this.cache.invalidateLists()]);
    }
}
