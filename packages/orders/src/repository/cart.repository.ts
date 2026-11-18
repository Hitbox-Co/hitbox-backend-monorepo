import { randomUUID } from 'node:crypto';
import type { CartItem, PrismaClient } from '@hitbox/database';

/** Cart rows. Removal on payment happens inside `OrderWriteRepository.markPaid`. */
export class CartRepository {
    constructor(private readonly prisma: PrismaClient) { }

    list(userId: string): Promise<CartItem[]> {
        return this.prisma.cartItem.findMany({
            where: { userId },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        });
    }

    count(userId: string): Promise<number> {
        return this.prisma.cartItem.count({ where: { userId } });
    }

    /** `findFirst`: the compound unique cannot be addressed with a null variant. */
    findOne(userId: string, productId: string, variantId: string | null): Promise<CartItem | null> {
        return this.prisma.cartItem.findFirst({ where: { userId, productId, variantId } });
    }

    create(input: { userId: string; productId: string; variantId: string | null }): Promise<CartItem> {
        const now = new Date();
        return this.prisma.cartItem.create({
            data: { id: randomUUID(), ...input, createdAt: now, updatedAt: now },
        });
    }

    async deleteById(userId: string, id: string): Promise<number> {
        return (await this.prisma.cartItem.deleteMany({ where: { id, userId } })).count;
    }

    async clear(userId: string): Promise<number> {
        return (await this.prisma.cartItem.deleteMany({ where: { userId } })).count;
    }
}
