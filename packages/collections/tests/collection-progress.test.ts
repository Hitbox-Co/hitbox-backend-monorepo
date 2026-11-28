import { describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@hitbox/shared';
import type { IDropCardCatalog } from '../src/domain/interfaces/drop-card-catalog.interface';
import { collectionDetailQuerySchema, toProgress } from '../src/dto/collection-progress.dto';
import type { CollectionProgressRepository } from '../src/repository/collection-progress.repository';
import { CollectionProgressService } from '../src/service/collection-progress.service';

const logger = { debug: jest.fn() } as never;

const ARTIST = { id: 'artist-1', name: 'Kaze', slug: 'kaze' };
const COLLECTION = {
    id: 'col-1',
    name: 'Tour 2026',
    slug: 'tour-2026',
    description: null,
    heroImageUrl: null,
    artist: ARTIST,
};
const card = (id: string) => ({
    id,
    name: `Drop ${id}`,
    description: null,
    imageUrl: null,
    rarity: null,
    category: null,
    artist: ARTIST,
    price: { amount: '10.00', currency: 'USD', isFree: false },
    totalSupply: 100,
    mintedCount: 1,
    rewardPoints: 0,
    status: 'ACTIVE',
    isViewable: true,
    isPurchasable: true,
    unavailableReason: null,
    variants: [],
});

/** A five-drop collection (d1..d5); the cards come back in scrambled order on purpose. */
function build(owned: string[] = ['d1', 'd2', 'd3']) {
    const dropIds = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const progress = {
        findPublicArtist: jest.fn(async (id: string) => (id === ARTIST.id ? ARTIST : null)),
        findArtistCollections: jest.fn(async () => ({ items: [COLLECTION], total: 1 })),
        findPublicCollection: jest.fn(async (id: string) => (id === COLLECTION.id ? COLLECTION : null)),
        releasedDropIds: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, dropIds]))),
        ownedDropIds: jest.fn(async () => new Set(owned)),
    } as unknown as jest.Mocked<CollectionProgressRepository>;
    const dropCards = {
        findCards: jest.fn(async (ids: string[]) => [...ids].reverse().map(card)),
    } as unknown as jest.Mocked<IDropCardCatalog>;
    return { progress, dropCards, service: new CollectionProgressService({ progress, dropCards, logger }) };
}

const detailQuery = (q: Record<string, unknown> = {}) => collectionDetailQuerySchema.parse(q);

describe('toProgress', () => {
    it('computes owned, missing, percentage and complete', () => {
        expect(toProgress(3, 5)).toEqual({ owned: 3, total: 5, missing: 2, percentage: 60, complete: false });
        expect(toProgress(5, 5)).toMatchObject({ missing: 0, percentage: 100, complete: true });
    });

    it('an empty collection is 0% and never complete', () => {
        expect(toProgress(0, 0)).toEqual({ owned: 0, total: 0, missing: 0, percentage: 0, complete: false });
    });
});

describe('CollectionProgressService.getDetail', () => {
    it('lists all five drops in release order, flagging the three owned and the two missing', async () => {
        const { service } = build();
        const result = await service.getDetail('col-1', detailQuery(), 'me');

        expect(result.progress).toEqual({ owned: 3, total: 5, missing: 2, percentage: 60, complete: false });
        expect(result.drops.map((d) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
        expect(result.drops.map((d) => d.owned)).toEqual([true, true, true, false, false]);
    });

    it('show=missing returns only the two drops the buyer lacks, as full cards', async () => {
        const { service } = build();
        const result = await service.getDetail('col-1', detailQuery({ show: 'missing' }), 'me');

        expect(result.drops.map((d) => d.id)).toEqual(['d4', 'd5']);
        expect(result.drops[0]).toMatchObject({ name: 'Drop d4', isPurchasable: true, owned: false });
        // progress still describes the whole set, not the filtered view
        expect(result.progress).toMatchObject({ owned: 3, total: 5 });
    });

    it('show=owned returns only the three owned', async () => {
        const { service } = build();
        const result = await service.getDetail('col-1', detailQuery({ show: 'owned' }), 'me');
        expect(result.drops.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    });

    it('a complete set has nothing missing', async () => {
        const { service } = build(['d1', 'd2', 'd3', 'd4', 'd5']);
        const result = await service.getDetail('col-1', detailQuery({ show: 'missing' }), 'me');
        expect(result.drops).toEqual([]);
        expect(result.progress?.complete).toBe(true);
    });

    it('a guest sees every drop with owned=null and no progress, and no ownership lookup runs', async () => {
        const { service, progress } = build();
        const result = await service.getDetail('col-1', detailQuery(), undefined);

        expect(result.progress).toBeNull();
        expect(result.drops).toHaveLength(5);
        expect(result.drops.every((d) => d.owned === null)).toBe(true);
        expect(progress.ownedDropIds).not.toHaveBeenCalled();
    });

    it('show=missing for a guest returns nothing rather than pretending everything is missing', async () => {
        const { service } = build();
        const result = await service.getDetail('col-1', detailQuery({ show: 'missing' }), undefined);
        expect(result.drops).toEqual([]);
    });

    it('passes the market to the card lookup', async () => {
        const { service, dropCards } = build();
        const marketId = '7c1d4f0e-2b6a-4a58-9d31-0a4b1f0c9e11';
        await service.getDetail('col-1', detailQuery({ marketId }), 'me');
        expect(dropCards.findCards).toHaveBeenCalledWith(['d1', 'd2', 'd3', 'd4', 'd5'], marketId);
    });

    it('skips a drop that has no card instead of failing', async () => {
        const { service, dropCards } = build();
        dropCards.findCards.mockResolvedValueOnce([card('d1'), card('d2')]);
        const result = await service.getDetail('col-1', detailQuery(), 'me');
        expect(result.drops.map((d) => d.id)).toEqual(['d1', 'd2']);
        // the numbers still count all five released drops
        expect(result.progress?.total).toBe(5);
    });

    it('an unknown or private collection is a 404 with its own code', async () => {
        const { service } = build();
        await expect(service.getDetail('nope', detailQuery(), 'me')).rejects.toMatchObject({
            statusCode: 404,
            code: 'COLLECTIONS_COLLECTION_NOT_FOUND',
        });
        await expect(service.getDetail('nope', detailQuery(), 'me')).rejects.toBeInstanceOf(AppError);
    });
});

describe('CollectionProgressService.listForArtist', () => {
    it('returns each collection with totalDrops and my progress', async () => {
        const { service } = build();
        const result = await service.listForArtist('artist-1', { page: 1, limit: 20 }, 'me');

        expect(result.artist).toEqual(ARTIST);
        expect(result.total).toBe(1);
        expect(result.items[0]).toMatchObject({
            id: 'col-1',
            totalDrops: 5,
            progress: { owned: 3, total: 5, missing: 2, percentage: 60, complete: false },
        });
    });

    it('a guest gets totalDrops but progress null', async () => {
        const { service, progress } = build();
        const result = await service.listForArtist('artist-1', { page: 1, limit: 20 });

        expect(result.items[0]).toMatchObject({ totalDrops: 5, progress: null });
        expect(progress.ownedDropIds).not.toHaveBeenCalled();
    });

    it('pages with skip/take', async () => {
        const { service, progress } = build();
        await service.listForArtist('artist-1', { page: 3, limit: 10 }, 'me');
        expect(progress.findArtistCollections).toHaveBeenCalledWith('artist-1', 20, 10);
    });

    it('an unknown or non-public artist is a 404 with its own code', async () => {
        const { service } = build();
        await expect(service.listForArtist('nobody', { page: 1, limit: 20 }, 'me')).rejects.toMatchObject({
            statusCode: 404,
            code: 'COLLECTIONS_ARTIST_NOT_FOUND',
        });
    });
});

describe('collectionDetailQuerySchema', () => {
    it('defaults show to all and ignores a bad marketId', () => {
        const parsed = collectionDetailQuerySchema.parse({ marketId: 'nope' });
        expect(parsed.show).toBe('all');
        expect(parsed.marketId).toBeUndefined();
    });

    it('rejects an unknown show value', () => {
        expect(collectionDetailQuerySchema.safeParse({ show: 'bought' }).success).toBe(false);
    });
});
