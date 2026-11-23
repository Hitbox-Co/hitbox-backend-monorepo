import { describe, expect, it, jest } from '@jest/globals';
import { CartService } from '../src/service/cart.service';

/** docs/mobile-app/cart-api.md */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const card = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: id, isViewable: true, isPurchasable: true, unavailableReason: null, status: 'ACTIVE',
    price: { amount: '110.00', currency: 'USD', isFree: false },
    variants: [{ id: 'v1', label: 'M', isActive: true }, { id: 'v2', label: 'L', isActive: false }], ...over,
});
const row = (productId: string, over: Record<string, unknown> = {}) => ({
    id: `c-${productId}`, userId: 'u1', productId, variantId: null, publicCode: null,
    createdAt: new Date('2026-11-18T10:00:00Z'), updatedAt: new Date('2026-11-18T10:00:00Z'), ...over,
});

function build(opts: { cards?: unknown[]; rows?: unknown[]; existing?: unknown; count?: number } = {}) {
    const cart = {
        list: jest.fn(async () => opts.rows ?? []),
        count: jest.fn(async () => opts.count ?? 0),
        findOne: jest.fn(async () => opts.existing ?? null),
        create: jest.fn(async (input: { productId: string; variantId: string | null }) => row(input.productId, input)),
        deleteById: jest.fn(async () => 1),
        clear: jest.fn(async () => 3),
    };
    const catalog = { findCards: jest.fn(async () => opts.cards ?? [card('p1')]) };
    return { service: new CartService({ cart: cart as never, catalog: catalog as never, logger: silentLogger }), cart };
}

describe('CartService.add', () => {
    it('adds a purchasable drop (201)', async () => {
        const { service } = build();
        await expect(service.add('u1', { productId: 'p1', variantId: 'v1' })).resolves.toMatchObject({
            created: true, item: { productId: 'p1', variant: { id: 'v1', label: 'M' } },
        });
    });

    it('is idempotent', async () => {
        const { service, cart } = build({ existing: row('p1') });
        await expect(service.add('u1', { productId: 'p1' })).resolves.toMatchObject({ created: false });
        expect(cart.create).not.toHaveBeenCalled();
    });

    it.each([
        ['NOT_ON_SALE', 'ORDERS_NOT_PURCHASABLE'],
        ['CLOSED', 'ORDERS_NOT_PURCHASABLE'],
        ['NO_PRICE', 'ORDERS_NO_PRICE'],
    ])('refuses a drop that is %s with %s', async (reason, code) => {
        const { service } = build({ cards: [card('p1', { isPurchasable: false, unavailableReason: reason })] });
        await expect(service.add('u1', { productId: 'p1' })).rejects.toMatchObject({ statusCode: 400, code });
    });

    it('an unknown drop is a 404', async () => {
        await expect(build({ cards: [] }).service.add('u1', { productId: 'p1' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('a variant that is switched off or from another drop is a 404', async () => {
        const { service } = build();
        await expect(service.add('u1', { productId: 'p1', variantId: 'v2' })).rejects.toMatchObject({ code: 'ORDERS_VARIANT_NOT_FOUND' });
        await expect(service.add('u1', { productId: 'p1', variantId: 'zz' })).rejects.toMatchObject({ code: 'ORDERS_VARIANT_NOT_FOUND' });
    });

    it('a full cart is a 409', async () => {
        await expect(build({ count: 50 }).service.add('u1', { productId: 'p1' })).rejects.toMatchObject({ statusCode: 409, code: 'ORDERS_CART_FULL' });
    });
});

describe('CartService.get', () => {
    it('totals purchasable rows per currency and counts the rest', async () => {
        const { service } = build({
            rows: [row('a'), row('b'), row('c'), row('d')],
            cards: [
                card('a'),
                card('b', { price: { amount: '225.50', currency: 'USD', isFree: false } }),
                card('c', { price: { amount: '9.99', currency: 'EUR', isFree: false } }),
                card('d', { isPurchasable: false, unavailableReason: 'CLOSED' }),
            ],
        });
        const view = await service.get('u1');
        expect(view.summary).toEqual({
            itemCount: 4,
            purchasableCount: 3,
            subtotals: [{ currency: 'USD', amount: '335.50' }, { currency: 'EUR', amount: '9.99' }],
        });
        expect(view.items.map((i) => i.product?.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});
