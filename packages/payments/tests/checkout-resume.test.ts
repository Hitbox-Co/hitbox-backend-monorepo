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

/** A retried POST /checkout must not place a second order or hold a second unit. */
describe('CheckoutService.checkout — repeated checkout', () => {
    function buildCheckout(openOrderId: string | null) {
        const { service, gateway, payments } = build();
        const orders = (service as unknown as { deps: { orders: Record<string, unknown> } }).deps.orders;
        orders.findOpenCheckout = jest.fn(async () => openOrderId);
        orders.placeOrder = jest.fn(async () => {
            throw new Error('placeOrder must not be reached in this test');
        });
        return { service, gateway, payments, orders };
    }
    const dto = { productId: 'p1', quantity: 1, termsAccepted: true, gateway: 'STRIPE' } as never;

    it('hands back the open order instead of placing a new one', async () => {
        const { service, orders } = buildCheckout('o1');
        const view = await service.checkout(dto, 'buyer-1');
        expect(orders.findOpenCheckout).toHaveBeenCalledWith({ buyerId: 'buyer-1', productId: 'p1', variantId: null });
        expect(orders.placeOrder).not.toHaveBeenCalled();
        expect(view).toMatchObject({ orderId: 'o1', clientToken: 'pi_1_secret' });
    });

    it('places a new order when there is no open one', async () => {
        const { service, orders } = buildCheckout(null);
        await expect(service.checkout(dto, 'buyer-1')).rejects.toThrow('placeOrder must not be reached');
        expect(orders.placeOrder).toHaveBeenCalledTimes(1);
    });
});
