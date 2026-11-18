import { describe, expect, it, jest } from '@jest/globals';
import { PAYMENT_EVENTS } from '../src/constants/payments.constant';
import { PaymentService } from '../src/service/payment.service';

/** Tax issues the invoice on `payments.order.settled` — it must fire exactly when the order is paid. */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

function build(markPaid: boolean) {
    const publish = jest.fn(async () => undefined);
    const service = new PaymentService({
        payments: { transition: jest.fn(async () => 1) } as never,
        orders: { markPaid: jest.fn(async () => markPaid) } as never,
        finance: { postSaleRevenue: jest.fn(async () => undefined) } as never,
        eventBus: { publish } as never,
        audit: { record: jest.fn(async () => undefined) } as never,
        logger: silentLogger,
    });
    const transaction = {
        id: 't1', orderId: 'o1', status: 'PENDING', currency: 'USD',
        amount: { toFixed: () => '30.00' },
    } as never;
    return { service, publish, transaction };
}

const settleInput = (transaction: never) => ({
    transaction, gatewayRef: 'pi_1', settledAt: new Date('2026-11-18T10:00:00Z'), correlationId: 'c1',
});

describe('PaymentService.settle — order settled event', () => {
    it('publishes payments.order.settled when the order was marked paid', async () => {
        const { service, publish, transaction } = build(true);
        await service.settle(settleInput(transaction));
        expect(PAYMENT_EVENTS.ORDER_SETTLED).toBe('payments.order.settled');
        expect(publish).toHaveBeenCalledWith(PAYMENT_EVENTS.ORDER_SETTLED, { orderId: 'o1' });
    });

    it('does not publish it when settlement is parked for review', async () => {
        const { service, publish, transaction } = build(false);
        await service.settle(settleInput(transaction));
        expect(publish).toHaveBeenCalledWith(PAYMENT_EVENTS.PAYMENT_SUCCEEDED, expect.anything());
        expect(publish).not.toHaveBeenCalledWith(PAYMENT_EVENTS.ORDER_SETTLED, expect.anything());
    });
});
