/**
 * One-off backfill: puts the units of already-refunded, returned orders back
 * into stock.
 *
 *   pnpm jobs:release-refunded-units            ← dry run: lists what it would release
 *   pnpm jobs:release-refunded-units --apply    ← does it
 *
 * Refunds executed before the restock rule (docs/orders/order-payments-and-refunds-api.md,
 * "The unit after a refund") left a shipped-and-returned unit tied to its
 * REFUNDED order, which keeps it off sale for ever. This applies the same rule
 * the refund now applies itself: an order whose refund is PROCESSED with the
 * return received lets go of its unit (`skuId` cleared, holds RELEASED).
 *
 * Nothing else changes. A unit that came back with a damaged, missing or
 * tampered tag stays quarantined (`resaleBlocked`), exactly as the refund left
 * it — releasing it from the order only means it can go back on sale once that
 * block is lifted. The RELEASED reservation row keeps which unit it was.
 *
 * Safe to run twice: a released order no longer matches.
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same env loading as src/index.ts, before anything reads it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
config({ path: resolve(root, '.env.local') });
config({ path: resolve(root, '.env') });

const { prisma } = await import('@hitbox/database');

const apply = process.argv.includes('--apply');

try {
    const orders = await prisma.order.findMany({
        where: {
            status: 'REFUNDED',
            skuId: { not: null },
            refundRequests: { some: { status: 'PROCESSED', physicalReturnConfirmedAt: { not: null } } },
        },
        select: {
            id: true,
            publicCode: true,
            skuId: true,
            sku: { select: { skuCode: true, resaleBlocked: true } },
        },
        orderBy: { placedAt: 'asc' },
    });

    console.log(`${orders.length} refunded order(s) with a returned unit still attached${apply ? '' : ' (dry run)'}:`);
    for (const order of orders) {
        const note = order.sku?.resaleBlocked ? ' — stays quarantined (resaleBlocked)' : ' — back on sale';
        console.log(`  ${order.publicCode ?? order.id}  ${order.sku?.skuCode ?? order.skuId}${note}`);
        if (!apply) continue;

        await prisma.$transaction(async (tx) => {
            // Guarded on the unit we read, so a concurrent change is left alone.
            const released = await tx.order.updateMany({
                where: { id: order.id, status: 'REFUNDED', skuId: order.skuId },
                data: { skuId: null, updatedAt: new Date() },
            });
            if (released.count === 0) return;
            await tx.inventoryReservation.updateMany({
                where: { orderId: order.id, status: { in: ['HELD', 'COMMITTED'] } },
                data: { status: 'RELEASED' },
            });
        });
    }
    if (!apply && orders.length > 0) console.log('Run again with --apply to release them.');
    await prisma.$disconnect();
} catch (error) {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
}
