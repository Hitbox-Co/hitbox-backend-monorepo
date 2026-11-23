import { randomUUID } from 'node:crypto';
import type { PrismaClient, WishlistItem } from '@hitbox/database';

/** The only place in this module that touches Prisma. */
export class WishlistRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(userId: string, skip: number, take: number): Promise<{ items: WishlistItem[]; total: number }> {
        const [items, total] = await this.prisma.$transaction([
            this.prisma.wishlistItem.findMany({
                where: { userId },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip,
                take,
            }),
            this.prisma.wishlistItem.count({ where: { userId } }),
        ]);
        return { items, total };
    }

    /**
     * The row for (user, drop, variant). `findFirst`, not `findUnique`: the
     * compound unique cannot be addressed with a null variant.
     */
    findOne(userId: string, productId: string, variantId: string | null): Promise<WishlistItem | null> {
        return this.prisma.wishlistItem.findFirst({ where: { userId, productId, variantId } });
    }

    findById(userId: string, id: string): Promise<WishlistItem | null> {
        return this.prisma.wishlistItem.findFirst({ where: { id, userId } });
    }

    create(input: {
        userId: string;
        productId: string;
        variantId: string | null;
        notifyOnAvailable: boolean;
        note: string | null;
    }): Promise<WishlistItem> {
        return this.prisma.wishlistItem.create({
            data: { id: randomUUID(), ...input, createdAt: new Date() },
        });
    }

    update(id: string, data: { notifyOnAvailable?: boolean; note?: string | null }): Promise<WishlistItem> {
        return this.prisma.wishlistItem.update({ where: { id }, data });
    }

    async deleteById(userId: string, id: string): Promise<number> {
        const result = await this.prisma.wishlistItem.deleteMany({ where: { id, userId } });
        return result.count;
    }

    async deleteByProduct(userId: string, productId: string, variantId?: string): Promise<number> {
        const result = await this.prisma.wishlistItem.deleteMany({
            where: { userId, productId, ...(variantId ? { variantId } : {}) },
        });
        return result.count;
    }
}
