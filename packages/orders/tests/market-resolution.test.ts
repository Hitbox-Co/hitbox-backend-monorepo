import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { chooseMarket } from '../src/domain/market-resolution';
import { OrderWriteRepository } from '../src/repository/order-write.repository';

/**
 * The server's backup for picking a market when the app sends none.
 * The app should send `marketId`; this only decides when it does not.
 */

describe('chooseMarket (pure rules)', () => {
    const base = { preferredMarketId: null, addressMarketIds: [], defaultMarketId: null };

    it('nothing priced: null', () => {
        expect(chooseMarket({ ...base, pricedMarketIds: [] })).toBeNull();
    });

    it('a single priced market needs no choosing', () => {
        expect(chooseMarket({ ...base, pricedMarketIds: ['us'], preferredMarketId: 'in' }))
            .toEqual({ marketId: 'us', source: 'ONLY_PRICED' });
    });

    it('preferred market wins over address and default', () => {
        expect(chooseMarket({
            pricedMarketIds: ['us', 'in'], preferredMarketId: 'us', addressMarketIds: ['in'], defaultMarketId: 'in',
        })).toEqual({ marketId: 'us', source: 'PREFERRED' });
    });

    it('address market is next, billing before shipping', () => {
        expect(chooseMarket({
            pricedMarketIds: ['us', 'in', 'uk'], preferredMarketId: null, addressMarketIds: ['in', 'uk'], defaultMarketId: 'us',
        })).toEqual({ marketId: 'in', source: 'ADDRESS' });
        expect(chooseMarket({
            pricedMarketIds: ['us', 'uk'], preferredMarketId: null, addressMarketIds: ['in', 'uk'], defaultMarketId: 'us',
        })).toEqual({ marketId: 'uk', source: 'ADDRESS' });
    });

    it('then the default; a preference the drop is not priced in is skipped', () => {
        expect(chooseMarket({
            pricedMarketIds: ['us', 'in'], preferredMarketId: 'uk', addressMarketIds: [null], defaultMarketId: 'in',
        })).toEqual({ marketId: 'in', source: 'DEFAULT' });
    });

    it('several priced markets and none of them the buyer\'s: null, never "newest"', () => {
        expect(chooseMarket({
            pricedMarketIds: ['us', 'in'], preferredMarketId: 'uk', addressMarketIds: ['de'], defaultMarketId: 'fr',
        })).toBeNull();
    });
});

const now = new Date('2026-11-24T10:00:00Z');
const priceRow = (marketId: string, currency: string, amount: string) => ({
    amount: new Prisma.Decimal(amount), isFree: false, costOfGoods: null, marketId, market: { id: marketId, currency },
});

function build(o: {
    priced: string[];
    preferred?: string | null;
    addresses?: { id: string; countryCode: string }[];
    defaultId?: string | null;
}) {
    const rows: Record<string, ReturnType<typeof priceRow>> = {
        'm-us': priceRow('m-us', 'USD', '15.00'),
        'm-in': priceRow('m-in', 'INR', '899.00'),
        'm-uk': priceRow('m-uk', 'GBP', '12.00'),
    };
    const prisma = {
        drop: { findUnique: jest.fn(async () => ({ id: 'p1', name: 'Keychain', status: 'PUBLISHED', isActive: true, archivedAt: null, organizationId: null, releaseStart: null, releaseEnd: null })) },
        dropPrice: {
            findMany: jest.fn(async () => o.priced.map((marketId) => ({ marketId }))),
            findFirst: jest.fn(async (args: { where: { marketId?: string } }) =>
                args.where.marketId ? rows[args.where.marketId] ?? null : rows[o.priced[0]!]),
        },
        user: { findUnique: jest.fn(async () => ({ preferredMarketId: o.preferred ?? null })) },
        address: { findMany: jest.fn(async () => o.addresses ?? []) },
        market: { findFirst: jest.fn(async () => (o.defaultId ? { id: o.defaultId } : null)) },
        marketCountry: {
            findMany: jest.fn(async () => [
                { countryCode: 'IN', marketId: 'm-in' }, { countryCode: 'US', marketId: 'm-us' }, { countryCode: 'GB', marketId: 'm-uk' },
            ]),
        },
        sku: { findFirst: jest.fn(async () => ({ id: 'sku-1' })) },
    };
    return { repo: new OrderWriteRepository(prisma as never), prisma };
}

const q = { productId: 'p1', variantId: null, marketId: null, now, buyerId: 'u1', shippingAddressId: 'a-ship', billingAddressId: null };

describe('quote without a marketId (server backup)', () => {
    it('an explicit marketId is used as given, with no lookups', async () => {
        const { repo, prisma } = build({ priced: ['m-us', 'm-in'], preferred: 'm-us' });
        const quote = await repo.quote({ ...q, marketId: 'm-in' });
        expect(quote).toMatchObject({ marketId: 'm-in', currency: 'INR' });
        expect(prisma.dropPrice.findMany).not.toHaveBeenCalled();
    });

    it('priced in one market only: that market, no extra lookups', async () => {
        const { repo, prisma } = build({ priced: ['m-us'] });
        await expect(repo.quote(q)).resolves.toMatchObject({ marketId: 'm-us', currency: 'USD' });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('uses the buyer\'s preferred market first', async () => {
        const { repo } = build({ priced: ['m-us', 'm-in'], preferred: 'm-us', addresses: [{ id: 'a-ship', countryCode: 'IN' }] });
        await expect(repo.quote(q)).resolves.toMatchObject({ marketId: 'm-us', currency: 'USD' });
    });

    it('with no preference, follows the delivery address country (Kolkata → INR)', async () => {
        const { repo } = build({ priced: ['m-us', 'm-in'], addresses: [{ id: 'a-ship', countryCode: 'IN' }], defaultId: 'm-us' });
        const quote = await repo.quote(q);
        expect(quote).toMatchObject({ marketId: 'm-in', currency: 'INR' });
        expect(quote.unitPrice.toFixed(2)).toBe('899.00');
    });

    it('with neither, uses the default market', async () => {
        const { repo } = build({ priced: ['m-us', 'm-in'], defaultId: 'm-us' });
        await expect(repo.quote(q)).resolves.toMatchObject({ marketId: 'm-us' });
    });

    it('several markets and no way to place the buyer: 400 ORDERS_NO_PRICE listing the markets', async () => {
        const { repo } = build({ priced: ['m-us', 'm-in'], defaultId: 'm-uk' });
        await expect(repo.quote(q)).rejects.toMatchObject({
            statusCode: 400,
            details: { marketIds: ['m-us', 'm-in'] },
        });
    });
});
