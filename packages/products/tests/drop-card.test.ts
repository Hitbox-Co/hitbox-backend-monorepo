import { describe, expect, it, jest } from '@jest/globals';
import { createMarketplaceModule } from '@hitbox/marketplace';
import type { MarketplaceListingItem, MarketplaceListingsQuery } from '@hitbox/marketplace';
import { toDropCard } from '../src/domain/drop-card';

/** The card Discover and Marketplace both render, built in one place. */

const row = (over: Record<string, unknown> = {}) => ({
    id: 'd1',
    name: 'Lucky in Pink',
    description: null,
    rarity: 'UNCOMMON',
    category: 'FIGURE',
    totalSupply: 150,
    rewardPoints: 550,
    dropImages: [{ asset: { storageRef: 'drops/d1.png' } }],
    dropPrices: [{ amount: '110', isFree: false, market: { currency: 'USD', code: 'US' } }],
    artist: null,
    collection: { artist: { id: 'a1', name: 'Yuki Lab', slug: 'yuki-lab' } },
    _count: { skus: 9 },
    ...over,
}) as never;

const urls = { publicUrl: (ref: string) => `https://cdn.test/${ref}` };

describe('toDropCard', () => {
    it('maps every field the card renders', () => {
        expect(toDropCard(row(), urls, null)).toEqual({
            id: 'd1',
            name: 'Lucky in Pink',
            description: null,
            imageUrl: 'https://cdn.test/drops/d1.png',
            rarity: 'UNCOMMON',
            category: 'FIGURE',
            artist: { id: 'a1', name: 'Yuki Lab', slug: 'yuki-lab' },
            price: { amount: '110.00', currency: 'USD', isFree: false },
            totalSupply: 150,
            mintedCount: 9,
            rewardPoints: 550,
            isWishlisted: null,
        });
    });

    it('formats a cached string amount with two decimals', () => {
        const card = toDropCard(row({ dropPrices: [{ amount: '480.5', isFree: false, market: { currency: 'USD', code: 'US' } }] }), urls, null);
        expect(card.price).toEqual({ amount: '480.50', currency: 'USD', isFree: false });
    });

    it('a free drop is "0"; no price row is null', () => {
        expect(toDropCard(row({ dropPrices: [{ amount: null, isFree: true, market: { currency: 'USD', code: 'US' } }] }), urls, null).price)
            .toEqual({ amount: '0', currency: 'USD', isFree: true });
        expect(toDropCard(row({ dropPrices: [] }), urls, null).price).toBeNull();
    });

    it("prefers the drop's own artist over its collection's", () => {
        const own = { id: 'a2', name: 'Form & Co.', slug: 'form-co' };
        expect(toDropCard(row({ artist: own }), urls, null).artist).toEqual(own);
    });

    it('isWishlisted is true/false for a signed-in viewer', () => {
        expect(toDropCard(row(), urls, new Set(['d1'])).isWishlisted).toBe(true);
        expect(toDropCard(row(), urls, new Set()).isWishlisted).toBe(false);
    });
});

describe('Marketplace feed — Featured Listings never empty', () => {
    const card = (id: string) => ({ id }) as MarketplaceListingItem;

    function build(featured: string[], popular: string[]) {
        const findListings = jest.fn(async (q: MarketplaceListingsQuery) => {
            const ids = q.featuredOnly ? featured : q.sort === 'popular' ? popular : ['n1'];
            return { items: ids.map(card), total: ids.length };
        });
        const { service } = createMarketplaceModule({ catalog: { findListings } });
        return { service, findListings };
    }

    it('tops featured up from popular, without duplicates', async () => {
        const { service } = build(['f1'], ['f1', 'p1', 'p2']);
        const feed = await service.getFeed();
        expect(feed.featured.map((i) => i.id)).toEqual(['f1', 'p1', 'p2']);
    });

    it('is filled entirely from popular when nothing qualifies as featured', async () => {
        const { service } = build([], ['p1', 'p2']);
        expect((await service.getFeed()).featured.map((i) => i.id)).toEqual(['p1', 'p2']);
    });

    it('passes the category chip and viewer to every query', async () => {
        const { service, findListings } = build([], ['p1']);
        await service.getFeed({ category: 'figures' as never, viewerId: 'u1' });
        for (const [q] of findListings.mock.calls) {
            expect(q).toMatchObject({ category: 'figures', viewerId: 'u1' });
        }
    });

    it('does not run the top-up query when featured is already full', async () => {
        const full = Array.from({ length: 10 }, (_, i) => `f${i}`);
        const { service, findListings } = build(full, ['p1']);
        await service.getFeed();
        expect(findListings).toHaveBeenCalledTimes(2);
    });
});
