import { AppError } from '@hitbox/shared';
import { canTransition } from '../src/domain/order-status';
import { CheckoutSweepService } from '../src/service/checkout-sweep.service';
import { OrderService } from '../src/service/order.service';

/**
 * Cancelling orders and the checkout sweep — docs/orders/checkout-sweep.md.
 * Repositories are faked; the transactional writes (locks, guarded updates)
 * are exercised against a real database separately.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const VIEW = { organizationIds: null, canSeeMoney: true, canSeeBuyer: true };

describe('order status rules — cancelling', () => {
    it('only an unpaid order can be cancelled', () => {
        expect(canTransition('PENDING_PAYMENT', 'CANCELLED')).toBe(true);
        expect(canTransition('PAID', 'CANCELLED')).toBe(false);
        expect(canTransition('PROCESSING', 'CANCELLED')).toBe(false);
    });
});

describe('OrderService.changeStatus — CANCELLED', () => {
    function build(status: string) {
        const orders = {
            findById: jest.fn(async () => ({ id: 'o1', status, organizationId: null, unitAssignedAt: null })),
            changeStatus: jest.fn(async () => 1),
        };
        const writes = { cancelUnpaid: jest.fn(async () => true) };
        const eventBus = { publish: jest.fn(async () => undefined) };
        const audit = { record: jest.fn(async () => undefined) };
        const service = new OrderService({ orders: orders as never, writes: writes as never, audit, eventBus: eventBus as never, logger: silentLogger });
        jest.spyOn(service, 'getById').mockResolvedValue({ id: 'o1' } as never);
        return { service, orders, writes, eventBus, audit };
    }

    it.each(['PAID', 'PROCESSING'])('a %s order is refused with CANCEL_REQUIRES_REFUND', async (status) => {
        const { service, orders, writes } = build(status);
        const attempt = service.changeStatus({ id: 'o1', dto: { status: 'CANCELLED' }, view: VIEW, actorId: 'admin' });
        await expect(attempt).rejects.toBeInstanceOf(AppError);
        await expect(attempt).rejects.toMatchObject({ code: 'ORDERS_CANCEL_REQUIRES_REFUND', statusCode: 400 });
        expect(orders.changeStatus).not.toHaveBeenCalled();
        expect(writes.cancelUnpaid).not.toHaveBeenCalled();
    });

    it('an unpaid order is cancelled through cancelUnpaid, which frees its hold', async () => {
        const { service, orders, writes, eventBus, audit } = build('PENDING_PAYMENT');
        await service.changeStatus({ id: 'o1', dto: { status: 'CANCELLED', reason: 'buyer asked' }, view: VIEW, actorId: 'admin' });
        expect(writes.cancelUnpaid).toHaveBeenCalledWith(
            expect.objectContaining({ orderId: 'o1', source: 'ADMIN', actorId: 'admin', reason: 'buyer asked' }),
        );
        expect(orders.changeStatus).not.toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith('orders.order.status-changed', expect.objectContaining({ from: 'PENDING_PAYMENT', to: 'CANCELLED' }));
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'order.status.change',
            actor: { type: 'HITBOX_EMPLOYEE', id: 'admin' },
            beforeState: { status: 'PENDING_PAYMENT' },
        }));
    });

    it('a payment that lands at the same moment wins (conflict, not a cancel)', async () => {
        const { service, writes } = build('PENDING_PAYMENT');
        writes.cancelUnpaid.mockResolvedValueOnce(false);
        await expect(
            service.changeStatus({ id: 'o1', dto: { status: 'CANCELLED' }, view: VIEW, actorId: 'admin' }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });
});

describe('CheckoutSweepService', () => {
    function build(batches: string[][], cancelResult = true) {
        const writes = {
            releaseExpiredReservations: jest.fn(async () => 3),
            findExpiredUnpaid: jest.fn(async () => batches.shift() ?? []),
            cancelUnpaid: jest.fn(async () => cancelResult),
        };
        const eventBus = { publish: jest.fn(async () => undefined) };
        const sweep = new CheckoutSweepService({ writes: writes as never, eventBus: eventBus as never, logger: silentLogger, graceSeconds: 1800 });
        return { sweep, writes, eventBus };
    }

    it('releases expired holds, then cancels unpaid orders past the grace period', async () => {
        const { sweep, writes, eventBus } = build([['o1', 'o2']]);
        const now = new Date('2026-10-22T12:00:00Z');

        await expect(sweep.run(now)).resolves.toEqual({ releasedHolds: 3, cancelledOrders: 2 });
        expect(writes.releaseExpiredReservations).toHaveBeenCalledWith(now);
        // cutoff = now − 30 min
        expect(writes.findExpiredUnpaid).toHaveBeenCalledWith(new Date('2026-10-22T11:30:00Z'), 200);
        expect(writes.cancelUnpaid).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', source: 'CHECKOUT_SWEEP' }));
        expect(eventBus.publish).toHaveBeenCalledWith(
            'orders.order.status-changed',
            expect.objectContaining({ orderId: 'o1', to: 'CANCELLED', actorId: null }),
        );
    });

    it('an order paid between the query and the cancel is skipped, not counted', async () => {
        const { sweep, eventBus } = build([['o1']], false);
        await expect(sweep.run()).resolves.toEqual({ releasedHolds: 3, cancelledOrders: 0 });
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('keeps going in batches while batches are full, and stops on a short one', async () => {
        const full = Array.from({ length: 200 }, (_, i) => `o${i}`);
        const { sweep, writes } = build([full, ['last']]);
        await expect(sweep.run()).resolves.toMatchObject({ cancelledOrders: 201 });
        expect(writes.findExpiredUnpaid).toHaveBeenCalledTimes(2);
    });
});
