/**
 * One run of the checkout sweep, for an external scheduler.
 *
 *   pnpm jobs:checkout-sweep
 *
 * Releases stock holds that expired and cancels orders left unpaid past
 * UNPAID_ORDER_GRACE_SECONDS, then exits. The API server already does this on
 * a timer; use this instead when the server runs with
 * CHECKOUT_SWEEP_INTERVAL_SECONDS=0 — e.g. a platform cron every minute:
 *
 *   * * * * *  cd /app && pnpm jobs:checkout-sweep
 *
 * Exit code 1 on failure, so the scheduler can alert. See
 * docs/orders/checkout-sweep.md.
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same env loading as src/index.ts, before anything reads it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
config({ path: resolve(root, '.env.local') });
config({ path: resolve(root, '.env') });

const { prisma } = await import('@hitbox/database');
const { logger } = await import('@hitbox/shared');
const { bootstrap } = await import('../src/bootstrap');

try {
    const result = await bootstrap().runCheckoutSweep();
    logger.info(result, 'checkout sweep finished');
    console.log(`released ${result.releasedHolds} expired hold(s), cancelled ${result.cancelledOrders} unpaid order(s)`);
} catch (err) {
    logger.error({ err }, 'checkout sweep failed');
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
