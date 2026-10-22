import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { ORDER_EVENTS } from '../constants/orders.constant';
import type { OrderWriteRepository } from '../repository/order-write.repository';

export interface CheckoutSweepDeps {
    writes: OrderWriteRepository;
    eventBus: IEventBus;
    logger: Logger;
    /** How long after its hold expires an unpaid order is kept, for a late payment. */
    graceSeconds: number;
}

export interface CheckoutSweepResult {
    releasedHolds: number;
    cancelledOrders: number;
}

const BATCH = 200;
/** Bounds one run; anything left is picked up by the next tick. */
const MAX_BATCHES = 10;

/**
 * The scheduled checkout clean-up. Two jobs, in order:
 *
 *   1. **Release expired holds** — the unit goes back on sale the moment its
 *      hold runs out, so a buyer who walked away does not keep a numbered
 *      piece off the shelf.
 *   2. **Cancel unpaid orders** whose hold expired more than `graceSeconds`
 *      ago. The grace exists because card payments can settle after the hold
 *      (a slow 3-D Secure challenge): within it, a late payment is still
 *      honoured if nobody took the unit (OrderWriteRepository.markPaid).
 *
 * Safe to run on every instance, as often as wanted: every write is guarded,
 * so two sweeps racing simply split the work.
 */
export class CheckoutSweepService {
    constructor(private readonly deps: CheckoutSweepDeps) { }

    async run(now: Date = new Date()): Promise<CheckoutSweepResult> {
        const releasedHolds = await this.deps.writes.releaseExpiredReservations(now);

        const cutoff = new Date(now.getTime() - this.deps.graceSeconds * 1000);
        let cancelledOrders = 0;
        for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
            const ids = await this.deps.writes.findExpiredUnpaid(cutoff, BATCH);
            for (const orderId of ids) {
                const cancelled = await this.deps.writes.cancelUnpaid({ orderId, now });
                if (!cancelled) continue; // paid or cancelled meanwhile
                cancelledOrders += 1;
                await this.deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
                    orderId,
                    from: 'PENDING_PAYMENT',
                    to: 'CANCELLED',
                    actorId: null,
                    reason: 'Checkout expired without payment',
                });
            }
            if (ids.length < BATCH) break;
        }

        if (releasedHolds > 0 || cancelledOrders > 0) {
            this.deps.logger.info({ releasedHolds, cancelledOrders }, 'checkout sweep');
        }
        return { releasedHolds, cancelledOrders };
    }
}
