import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { pickBasePrice } from '../src/domain/base-price';
import { toDropCard } from '../src/domain/drop-card';
import { DropCardLookupAdapter } from '../src/domain/drop-card-lookup.adapter';
import { MarketplaceListingAdapter } from '../src/domain/marketplace-listing.adapter';
import { ProductDiscoveryAdapter } from '../src/domain/product-discovery.adapter';
import { pricedInMarket } from '../src/repository/product.repository';
import { ProductService } from '../src/service/product.service';

/**
 * Region selection (`?marketId=`): with an ACTIVE market selected, only drops
 * priced there are listed, prices are that market's, and a drop without one is
 * "not available in your region". No market selected (or an unusable id): the
 * default market, exactly as before. Never an error.
 */

const US = 'a1111111-1111-4111-8111-111111111111';
const IN = 'b2222222-2222-4222-8222-222222222222';
const UK = 'c3333333-3333-4333-8333-333333333333';

const usPrice = { amount: new Prisma.Decimal('15'), isFree: false, marketId: US, market: { currency: 'USD', code: 'US', isDefault: true } };
const inPrice = { amount: new Prisma.Decimal('899'), isFree: false, marketId: IN, market: { currency: 'INR', code: 'IN', isDefault: false } };

const row = (prices: unknown[], id = 'd1') => ({
    id, name: 'Keychain', description: null, rarity: 'COMMON', category: 'FIGURE',
    totalSupply: 100, rewardPoints: 0, dropImages: [], dropPrices: prices,
    artist: null, collection: null, _count: { skus: 0 },
    status: 'ACTIVE', isActive: true, archivedAt: null, releaseStart: null, releaseEnd: null, dropVariants: [],
}) as never;

/** `activeMarketId` as the real repository answers it: the id when it is an active market, else null. */
const activeMarketId = jest.fn(async (id?: string | null) => (id === US || id === IN ? id : null));

describe('pickBasePrice', () => {
    const prices = [usPrice, inPrice];
    it('no market: the default market', () => expect(pickBasePrice(prices)?.marketId).toBe(US));
    it('a market the drop is priced in: that price', () => expect(pickBasePrice(prices, IN)?.marketId).toBe(IN));
    it('a market the drop is NOT priced in: null, never another market\'s price', () => {
        expect(pickBasePrice([usPrice], IN)).toBeNull();
    });
    it('no rows: null', () => expect(pickBasePrice([], IN)).toBeNull());
    it('a row cached before this change (default only, no isDefault flag) is still the default', () => {
        const stale = [{ amount: '15', isFree: false, market: { currency: 'USD', code: 'US' } }];
        expect(pickBasePrice(stale as never)).toBe(stale[0]);
    });
});

describe('toDropCard with a market', () => {
    it('shows the selected market price and says which market it is', () => {
        expect(toDropCard(row([usPrice, inPrice]), undefined, null, IN).price)
            .toEqual({ amount: '899.00', currency: 'INR', isFree: false, marketId: IN });
    });
    it('keeps the default market when none is selected', () => {
        expect(toDropCard(row([usPrice, inPrice]), undefined, null).price)
            .toEqual({ amount: '15.00', currency: 'USD', isFree: false, marketId: US });
    });
    it('price is null when the drop is not priced in the selected market', () => {
        expect(toDropCard(row([usPrice]), undefined, null, IN).price).toBeNull();
    });
});

describe('pricedInMarket (the list filter)', () => {
    it('requires an ACTIVE base price (no variant) in that active market', () => {
        expect(pricedInMarket(IN)).toEqual({
            dropPrices: { some: { status: 'ACTIVE', variantId: null, marketId: IN, market: { isActive: true } } },
        });
    });
});

describe('Discover and Marketplace lists', () => {
    const findForDiscover = jest.fn(async () => ({ items: [row([usPrice, inPrice])], total: 1 }));
    const findForMarketplace = jest.fn(async () => ({ items: [row([usPrice, inPrice])], total: 1 }));
    const repo = { activeMarketId, findForDiscover, findForMarketplace, findWishlistedProductIds: jest.fn() } as never;
    const discover = new ProductDiscoveryAdapter(repo);
    const marketplace = new MarketplaceListingAdapter(repo);

    it('Discover: a selected market filters to drops priced there and shows that price', async () => {
        const result = await discover.findProducts({ page: 1, limit: 10, marketId: IN });
        expect(findForDiscover).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining(pricedInMarket(IN)),
        }));
        expect(result.items[0]!.price).toMatchObject({ currency: 'INR', marketId: IN });
        expect(result.total).toBe(1);
    });

    it('Marketplace: the same', async () => {
        const result = await marketplace.findListings({ sort: 'newest', page: 1, limit: 10, marketId: IN });
        expect(findForMarketplace).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining(pricedInMarket(IN)),
        }));
        expect(result.items[0]!.price).toMatchObject({ currency: 'INR', marketId: IN });
    });

    it('no market: no region filter, default market price (unchanged)', async () => {
        const result = await discover.findProducts({ page: 1, limit: 10 });
        const where = (findForDiscover.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where;
        expect(where).not.toHaveProperty('dropPrices');
        expect(result.items[0]!.price).toMatchObject({ currency: 'USD', marketId: US });
    });

    it('an unknown or inactive market is ignored, not an error: default behaviour', async () => {
        const result = await marketplace.findListings({ sort: 'newest', page: 1, limit: 10, marketId: UK });
        const where = (findForMarketplace.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where;
        expect(where).not.toHaveProperty('dropPrices');
        expect(result.items[0]!.price).toMatchObject({ currency: 'USD', marketId: US });
    });
});

describe('cart / wishlist card lookup', () => {
    const adapter = (rows: unknown[]) => new DropCardLookupAdapter({ findCardsByIds: jest.fn(async () => rows), activeMarketId } as never);

    it('shows the selected market price', async () => {
        const [card] = await adapter([row([usPrice, inPrice])]).findCards(['d1'], IN);
        expect(card?.price).toMatchObject({ currency: 'INR', amount: '899.00', marketId: IN });
        expect(card?.isPurchasable).toBe(true);
    });
    it('a drop not priced in the selected market is NOT_AVAILABLE_IN_REGION and not purchasable', async () => {
        const [card] = await adapter([row([usPrice])]).findCards(['d1'], IN);
        expect(card).toMatchObject({ price: null, isPurchasable: false, unavailableReason: 'NOT_AVAILABLE_IN_REGION' });
    });
    it('without a market it is unchanged (wishlist): default price, and NO_PRICE only when truly unpriced', async () => {
        const [priced] = await adapter([row([usPrice, inPrice])]).findCards(['d1']);
        expect(priced?.price).toMatchObject({ currency: 'USD', marketId: US });
        const [unpriced] = await adapter([row([])]).findCards(['d1']);
        expect(unpriced?.unavailableReason).toBe('NO_PRICE');
    });
});

describe('GET /products/:id and /products/code/:code', () => {
    const product = {
        id: 'd1', groupCode: 'G1', name: 'Keychain', description: null, vertical: null, category: null, rarity: null,
        status: 'ACTIVE', complianceStatus: null, totalSupply: 1, purchaseLimit: null, rewardPoints: 0,
        releaseStart: null, releaseEnd: null, publishedAt: null, isAgeSpecific: false, minimumAge: null,
        oddsDisclosureRef: null, isActive: true, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
        collectionId: null, artistId: null, organizationId: null, artist: null, collection: null,
        dropImages: [], dropPrices: [usPrice], dropType: null, dropVariants: [],
    };
    const service = new ProductService({
        products: { findById: jest.fn(async () => product), findByGroupCode: jest.fn(async () => product), activeMarketId },
    } as never);

    it('a drop not priced in the selected market is returned as not available in your region, with no price', async () => {
        for (const res of [await service.getById('d1', IN), await service.getByGroupCode('G1', IN)]) {
            expect(res).toMatchObject({ price: null, availableInMarket: false, unavailableReason: 'NOT_AVAILABLE_IN_REGION' });
        }
    });
    it('priced in the selected market: that price', async () => {
        const both = { ...product, dropPrices: [usPrice, inPrice] };
        const svc = new ProductService({ products: { findById: jest.fn(async () => both), activeMarketId } } as never);
        expect(await svc.getById('d1', IN)).toMatchObject({
            price: { currency: 'INR', amount: '899.00', marketId: IN }, availableInMarket: true, unavailableReason: null,
        });
    });
    it('no market, or an unusable one: the default price, available', async () => {
        for (const market of [undefined, UK]) {
            expect(await service.getById('d1', market)).toMatchObject({
                price: { currency: 'USD', marketId: US }, availableInMarket: true, unavailableReason: null,
            });
        }
    });
});
