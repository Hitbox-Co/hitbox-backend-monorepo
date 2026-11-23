import { describe, expect, it, jest } from '@jest/globals';
import { OrderWriteRepository } from '../src/repository/order-write.repository';

/** Paying for an order removes that drop/variant from the buyer's cart, in the same transaction. */

function build(opts: { updatedCount?: number } = {}) {
    const cartDelete = jest.fn(async () => ({ count: 1 }));
    const tx = {
        $queryRaw: jest.fn(async () => []),
        order: {
            findFirst: jest.fn(async () => ({ id: 'o1', buyerId: 'u1', productId: 'p1', variantId: 'v1' })),
            count: jest.fn(async () => 0),
            updateMany: jest.fn(async () => ({ count: opts.updatedCount ?? 1 })),
        },
        inventoryReservation: {
            findFirst: jest.fn(async () => ({ id: 'r1', skuId: 's1' })),
            count: jest.fn(async () => 0),
            update: jest.fn(async () => ({})),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        orderStatusHistory: { create: jest.fn(async () => ({})) },
        cartItem: { deleteMany: cartDelete },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { repo: new OrderWriteRepository(prisma as never), cartDelete };
}

describe('markPaid → cart', () => {
    it('deletes the matching cart row when the order is paid', async () => {
        const { repo, cartDelete } = build();
        await expect(repo.markPaid({ orderId: 'o1', settledAt: new Date() })).resolves.toBe(true);
        expect(cartDelete).toHaveBeenCalledWith({ where: { userId: 'u1', productId: 'p1', variantId: 'v1' } });
    });

    it('leaves the cart alone when the settlement is lost', async () => {
        const { repo, cartDelete } = build({ updatedCount: 0 });
        await expect(repo.markPaid({ orderId: 'o1', settledAt: new Date() })).resolves.toBe(false);
        expect(cartDelete).not.toHaveBeenCalled();
    });
});
