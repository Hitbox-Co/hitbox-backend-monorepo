import type { Prisma } from '@hitbox/database';

/**
 * Locks one unit's row until the surrounding transaction ends.
 *
 * Every write that decides "this unit belongs to this order" — checkout
 * taking a hold, settlement committing it, packing swapping it — takes this
 * lock first. Without it, two of them can each check "nobody else has this
 * unit", each see a clean answer (the other has not committed yet), and both
 * win: a late payment on an expired hold and a fresh checkout selling the same
 * one-of-500 piece twice.
 *
 * Row-level, so checkouts of *different* units never wait on each other.
 */
export async function lockSku(tx: Prisma.TransactionClient, skuId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "Sku" WHERE "id" = ${skuId}::uuid FOR UPDATE`;
}

/**
 * Whether another order already has this unit: a committed hold, a live hold,
 * or an order row pointing at it. Run after `lockSku`, so the answer stays
 * true until commit.
 */
export async function unitTakenByAnotherOrder(
    tx: Prisma.TransactionClient,
    input: { skuId: string; orderId: string; now: Date },
): Promise<boolean> {
    const [holds, orders] = await Promise.all([
        tx.inventoryReservation.count({
            where: {
                skuId: input.skuId,
                orderId: { not: input.orderId },
                OR: [{ status: 'COMMITTED' }, { status: 'HELD', expiresAt: { gt: input.now } }],
            },
        }),
        tx.order.count({ where: { skuId: input.skuId, id: { not: input.orderId } } }),
    ]);
    return holds > 0 || orders > 0;
}
