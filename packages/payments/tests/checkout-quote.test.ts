import { describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@hitbox/shared';
import { PAYMENTS_ERROR_CODES } from '../src/constants/payments.constant';
import { CheckoutService } from '../src/service/checkout.service';

/**
 * POST /checkout/quote and the billing-address / address-ownership rules on
 * POST /checkout. Every collaborator is faked.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

const sale = (over: Record<string, unknown> = {}) => ({
    productId: 'p1', variantId: null, marketId: 'm-in', currency: 'INR', unitPrice: '2499.00',
    availability: 'IN_STOCK', unavailableReason: null, ...over,
});

const gst = {
    countryCode: 'IN', stateCode: 'KA', taxType: 'GST', taxRate: '12.000',
    subtotal: '2231.25', taxAmount: '267.75', totalAmount: '2499.00',
};

function build(opts: {
    sale?: Record<string, unknown>;
    billing?: { id: string; countryCode: string; state: string | null } | null;
    resolveError?: Error;
    taxed?: boolean;
    withPorts?: boolean;
} = {}) {
    const orders = {
        quoteSale: jest.fn(async () => sale(opts.sale)),
        findOpenCheckout: jest.fn(async () => null),
        placeOrder: jest.fn(async () => ({
            orderId: 'o1', skuId: 's1', reservationId: 'r1', organizationId: null, marketId: 'm-in',
            unitPrice: '2499.00', amount: '2499.00', currency: 'INR', costOfGoods: null, expiresAt: '2026-11-18T10:15:00.000Z',
        })),
    };
    const addresses = {
        resolveForCheckout: jest.fn(async (_buyer: string, ids: { shippingAddressId?: string | null; billingAddressId?: string | null }) => {
            if (opts.resolveError) throw opts.resolveError;
            return {
                shipping: ids.shippingAddressId ? { id: ids.shippingAddressId, countryCode: 'IN', state: 'KA' } : null,
                billing: opts.billing === undefined ? (ids.billingAddressId ? { id: ids.billingAddressId, countryCode: 'IN', state: 'KA' } : null) : opts.billing,
            };
        }),
    };
    const tax = {
        estimate: jest.fn(async () => gst),
        taxedByDefault: jest.fn(async () => opts.taxed ?? true),
    };
    const payments = {
        createOrGet: jest.fn(async (row: { id: string }) => ({ transaction: { ...row, status: 'INITIATED', gatewayRef: null }, created: true })),
        transition: jest.fn(async () => 1),
    };
    const gateway = { name: 'STRIPE' as const, createCharge: jest.fn(async () => ({ gatewayRef: 'pi_1', clientToken: 'pi_1_secret', settled: false })), createRefund: jest.fn() };
    const service = new CheckoutService({
        orders: orders as never,
        payments: payments as never,
        gatewayConfigs: { resolve: jest.fn(async () => ({ credentialsRef: 'secrets://stripe/platform' })) } as never,
        gateway: gateway as never,
        eventBus: { publish: jest.fn() } as never,
        logger: silentLogger,
        holdSeconds: 900,
        ...(opts.withPorts === false ? {} : { addresses: addresses as never, tax: tax as never }),
    });
    return { service, orders, addresses, tax, gateway };
}

const body = { productId: 'p1', termsAccepted: true as const, quantity: 1, gateway: 'STRIPE' as const };

describe('CheckoutService.quote', () => {
    it('returns the full price breakdown, money as strings, total = price', async () => {
        const { service, tax } = build({ billing: { id: 'b1', countryCode: 'IN', state: 'KA' } });
        const quote = await service.quote({ productId: 'p1', billingAddressId: 'b1' }, 'buyer-1');

        expect(quote).toEqual({
            productId: 'p1', variantId: null, marketId: 'm-in', currency: 'INR',
            unitPrice: '2499.00', subtotal: '2231.25', taxType: 'GST', taxRate: '12.000', taxAmount: '267.75',
            shippingAmount: '0.00', totalAmount: '2499.00',
            availability: 'IN_STOCK', unavailableReason: null, billingAddressRequired: false,
        });
        // tax is computed for the billing country and state, from the quoted unit price
        expect(tax.estimate).toHaveBeenCalledWith({
            productId: 'p1', countryCode: 'IN', stateCode: 'KA', currency: 'INR', unitPrice: '2499.00',
        });
    });

    it('subtotal + tax + shipping is the total, so the parts add up to what is charged', async () => {
        const { service } = build({ billing: { id: 'b1', countryCode: 'IN', state: 'KA' } });
        const q = await service.quote({ productId: 'p1', billingAddressId: 'b1' }, 'buyer-1');
        const cents = (v: string) => Math.round(Number(v) * 100);
        expect(cents(q.subtotal) + cents(q.taxAmount) + cents(q.shippingAmount)).toBe(cents(q.totalAmount));
    });

    it('has no side effects: nothing is placed, held or charged', async () => {
        const { service, orders, gateway } = build();
        await service.quote({ productId: 'p1' }, 'buyer-1');
        expect(orders.placeOrder).not.toHaveBeenCalled();
        expect(gateway.createCharge).not.toHaveBeenCalled();
    });

    it('without a billing address, estimates on the fallback country and says one is required', async () => {
        const { service, tax } = build({ billing: null });
        const quote = await service.quote({ productId: 'p1' }, 'buyer-1');
        expect(tax.estimate).toHaveBeenCalledWith(expect.objectContaining({ countryCode: null, stateCode: null }));
        expect(quote.billingAddressRequired).toBe(true);
    });

    it('does not ask for a billing address when the sale is not taxed', async () => {
        const { service } = build({ billing: null, taxed: false });
        expect((await service.quote({ productId: 'p1' }, 'buyer-1')).billingAddressRequired).toBe(false);
    });

    it.each([
        ['SOLD_OUT', 'SOLD_OUT'],
        ['NOT_ON_SALE', 'CLOSED'],
    ])('%s is an answer, not an error, and still carries the price', async (availability, unavailableReason) => {
        const { service } = build({ sale: { availability, unavailableReason } });
        await expect(service.quote({ productId: 'p1' }, 'buyer-1')).resolves.toMatchObject({
            availability, unavailableReason, unitPrice: '2499.00', totalAmount: '2499.00',
        });
    });

    it("ignores an address id that is not the buyer's (resolves to none)", async () => {
        const { service, addresses } = build({ billing: null });
        await expect(service.quote({ productId: 'p1', billingAddressId: 'stranger' }, 'buyer-1')).resolves.toBeDefined();
        expect(addresses.resolveForCheckout).toHaveBeenCalledWith('buyer-1', { shippingAddressId: null, billingAddressId: 'stranger' });
    });

    it('rejects an archived address with the users error', async () => {
        const archived = AppError.badRequest('gone', 'USERS_ADDRESS_ARCHIVED');
        const { service } = build({ resolveError: archived });
        await expect(service.quote({ productId: 'p1', shippingAddressId: 'a1' }, 'buyer-1')).rejects.toMatchObject({ code: 'USERS_ADDRESS_ARCHIVED' });
    });

    it('passes orders errors through (unknown drop, no price)', async () => {
        const { service, orders } = build();
        orders.quoteSale.mockRejectedValueOnce(AppError.badRequest('no price', 'ORDERS_NO_PRICE'));
        await expect(service.quote({ productId: 'p1' }, 'buyer-1')).rejects.toMatchObject({ code: 'ORDERS_NO_PRICE' });
    });

    it('without the tax port, reports no tax rather than guessing', async () => {
        const { service } = build({ withPorts: false });
        await expect(service.quote({ productId: 'p1' }, 'buyer-1')).resolves.toMatchObject({
            taxType: null, taxRate: '0.000', taxAmount: '0.00', subtotal: '2499.00', totalAmount: '2499.00', billingAddressRequired: false,
        });
    });
});

describe('CheckoutService.checkout: billing address and address ownership', () => {
    it('refuses a taxed drop with no billing address: 400 PAYMENTS_BILLING_ADDRESS_REQUIRED, nothing held', async () => {
        const { service, orders } = build({ billing: null });
        await expect(service.checkout(body, 'buyer-1')).rejects.toMatchObject({
            statusCode: 400, code: PAYMENTS_ERROR_CODES.BILLING_ADDRESS_REQUIRED, details: { currency: 'INR' },
        });
        expect(orders.placeOrder).not.toHaveBeenCalled();
    });

    it('an id that is not the buyer\'s counts as no billing address', async () => {
        const { service, orders } = build({ billing: null });
        await expect(service.checkout({ ...body, billingAddressId: 'stranger' }, 'buyer-1')).rejects.toMatchObject({
            code: PAYMENTS_ERROR_CODES.BILLING_ADDRESS_REQUIRED,
        });
        expect(orders.placeOrder).not.toHaveBeenCalled();
    });

    it('proceeds with a valid billing address, passing only the validated ids to the order', async () => {
        const { service, orders } = build();
        await service.checkout({ ...body, shippingAddressId: 's1', billingAddressId: 'b1' }, 'buyer-1');
        expect(orders.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ shippingAddressId: 's1', billingAddressId: 'b1' }));
    });

    it('a stranger\'s shipping id is dropped from the order but does not block checkout', async () => {
        const { service, orders, addresses } = build();
        addresses.resolveForCheckout.mockResolvedValueOnce({ shipping: null, billing: { id: 'b1', countryCode: 'IN', state: 'KA' } });
        await service.checkout({ ...body, shippingAddressId: 'stranger', billingAddressId: 'b1' }, 'buyer-1');
        expect(orders.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ shippingAddressId: null, billingAddressId: 'b1' }));
    });

    it('rejects an archived address before anything is held', async () => {
        const { service, orders } = build({ resolveError: AppError.badRequest('gone', 'USERS_ADDRESS_ARCHIVED') });
        await expect(service.checkout({ ...body, billingAddressId: 'b1' }, 'buyer-1')).rejects.toMatchObject({ code: 'USERS_ADDRESS_ARCHIVED' });
        expect(orders.placeOrder).not.toHaveBeenCalled();
    });

    it('does not ask for billing when the drop is not taxed, or is free', async () => {
        const untaxed = build({ billing: null, taxed: false });
        await expect(untaxed.service.checkout(body, 'buyer-1')).resolves.toMatchObject({ orderId: 'o1' });

        const free = build({ billing: null, sale: { unitPrice: '0.00' } });
        await expect(free.service.checkout(body, 'buyer-1')).resolves.toMatchObject({ orderId: 'o1' });
    });

    it('lets sold-out / closed drops fail with their own error, not the billing one', async () => {
        const { service, orders } = build({ billing: null, sale: { availability: 'SOLD_OUT', unavailableReason: 'SOLD_OUT' } });
        orders.placeOrder.mockRejectedValueOnce(AppError.conflict('sold out', 'ORDERS_OUT_OF_STOCK'));
        await expect(service.checkout(body, 'buyer-1')).rejects.toMatchObject({ code: 'ORDERS_OUT_OF_STOCK' });
    });

    it('charges exactly what the quote called the total', async () => {
        const { service, gateway } = build({ billing: { id: 'b1', countryCode: 'IN', state: 'KA' } });
        const quote = await service.quote({ productId: 'p1', billingAddressId: 'b1' }, 'buyer-1');
        const view = await service.checkout({ ...body, billingAddressId: 'b1' }, 'buyer-1');
        expect(view.amount).toBe(quote.totalAmount);
        expect(gateway.createCharge).toHaveBeenCalledWith(expect.objectContaining({ amount: quote.totalAmount, currency: quote.currency }));
    });

    it('a retried checkout still resumes the open order without re-checking addresses', async () => {
        const { service, orders, addresses } = build({ billing: null });
        orders.findOpenCheckout.mockResolvedValueOnce('o-open' as never);
        const resume = jest.spyOn(service, 'resume').mockResolvedValueOnce({ orderId: 'o-open' } as never);
        await expect(service.checkout(body, 'buyer-1')).resolves.toMatchObject({ orderId: 'o-open' });
        expect(resume).toHaveBeenCalled();
        expect(addresses.resolveForCheckout).not.toHaveBeenCalled();
    });
});
