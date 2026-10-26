import { describe, expect, it, jest } from '@jest/globals';
import { CheckoutService } from '../src/service/checkout.service';

/** POST /checkout/:orderId/resume — docs/orders/buyer-orders-api.md. */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const expiresAt = new Date('2026-10-23T10:15:00Z');

function build(opts: { status?: string; buyerId?: string; hold?: unknown; txStatus?: string; gateway?: boolean } = {}) {
    const orders = {
        findOrderSummary: jest.fn(async () => ({
            orderId: 'o1', buyerId: opts.buyerId ?? 'buyer-1', status: opts.status ?? 'PENDING_PAYMENT',
            organizationId: null, skuId: null, claimId: null, amount: '30.00', currency: 'USD', gateway: 'STRIPE',
        })),
        findLiveHold: jest.fn(async () => (opts.hold === undefined ? { reservationId: 'res-1', skuId: 'sku-1', expiresAt } : opts.hold)),
    };
    const payments = {
        findByOrder: jest.fn(async () => [{ id: 't1', status: opts.txStatus ?? 'INITIATED', gateway: 'STRIPE', gatewayRef: null, idempotencyKey: 'order:o1:attempt:1' }]),
        transition: jest.fn(async () => 1),
    };
    const gateway = { name: 'STRIPE' as const, createCharge: jest.fn(async () => ({ gatewayRef: 'pi_1', clientToken: 'pi_1_secret', settled: false })), createRefund: jest.fn() };
    const service = new CheckoutService({
        orders: orders as never, payments: payments as never,
        gatewayConfigs: { resolve: jest.fn(async () => ({ credentialsRef: 'secrets://stripe/platform' })) } as never,
        gateway: opts.gateway === false ? undefined : (gateway as never),
        eventBus: { publish: jest.fn() } as never, logger: silentLogger, holdSeconds: 900,
    });
    return { service, gateway, payments };
}

describe('CheckoutService.resume', () => {
    it('returns the same charge (same idempotency key) with a client token', async () => {
        const { service, gateway, payments } = build();
        const view = await service.resume('o1', 'buyer-1');
        expect(gateway.createCharge).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'order:o1:attempt:1', amount: '30.00' }));
        expect(payments.transition).toHaveBeenCalledWith(expect.objectContaining({ from: 'INITIATED', data: expect.objectContaining({ status: 'PENDING' }) }));
        expect(view).toMatchObject({ orderId: 'o1', clientToken: 'pi_1_secret', status: 'PENDING', reservationExpiresAt: expiresAt.toISOString() });
    });

    it('works without a gateway adapter (client token null)', async () => {
        const { service } = build({ gateway: false });
        await expect(service.resume('o1', 'buyer-1')).resolves.toMatchObject({ clientToken: null, status: 'INITIATED' });
    });

    it("someone else's order is a 404", async () => {
        const { service } = build({ buyerId: 'buyer-2' });
        await expect(service.resume('o1', 'buyer-1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it.each(['PAID', 'CANCELLED'])('a %s order is not payable', async (status) => {
        const { service } = build({ status });
        await expect(service.resume('o1', 'buyer-1')).rejects.toMatchObject({ code: 'PAYMENTS_ORDER_NOT_PAYABLE' });
    });

    it('an expired hold means starting again', async () => {
        const { service, gateway } = build({ hold: null });
        await expect(service.resume('o1', 'buyer-1')).rejects.toMatchObject({ code: 'PAYMENTS_RESERVATION_EXPIRED' });
        expect(gateway.createCharge).not.toHaveBeenCalled();
    });
});
