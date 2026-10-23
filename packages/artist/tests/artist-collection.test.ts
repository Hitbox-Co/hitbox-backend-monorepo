import pino from 'pino';
import { AppError } from '@hitbox/shared';
import {
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
    MAX_LIVE_COLLECTIONS_PER_ARTIST,
} from '../src/collection/constants/artist-collection.constant';
import {
    adminListCollectionsQuerySchema,
    createCollectionSchema,
    updateCollectionSchema,
} from '../src/collection/dto/artist-collection.dto';
import type { ArtistCollectionRepository, CollectionRow } from '../src/collection/repository/artist-collection.repository';
import { ArtistCollectionService } from '../src/collection/service/artist-collection.service';
import { ARTIST_SELF_ERROR_CODES } from '../src/self/constants/artist-self.constant';
import type { ArtistImageAssetRef, IArtistImageStorage } from '../src/self/domain/artist-image-storage.interface';
import type { ArtistSelfRepository, ArtistSelfRow } from '../src/self/repository/artist-self.repository';

/**
 * Artist collections — docs/artist-collection/.
 * No database: the collections table is an in-memory array, so ordering,
 * archiving and slug rules run for real against it.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ARTIST = '22222222-2222-4222-8222-222222222222';
const OTHER_ARTIST = '99999999-9999-4999-8999-999999999999';
const ORG = '33333333-3333-4333-8333-333333333333';
const ASSET = '44444444-4444-4444-8444-444444444444';

let seq = 0;
const newId = () => `c0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function artist(overrides: Partial<ArtistSelfRow> = {}): ArtistSelfRow {
    return {
        id: ARTIST, slug: 'kaze', name: 'Kaze', organizationId: ORG,
        isActive: true, archivedAt: null, ...overrides,
    } as ArtistSelfRow;
}

type Stored = CollectionRow;

function setup(opts: {
    me?: ArtistSelfRow | null;
    existing?: Partial<Stored>[];
    liveDrops?: Record<string, number>;
    asset?: Partial<ArtistImageAssetRef> | null;
    images?: boolean;
} = {}) {
    const me = opts.me === undefined ? artist() : opts.me;
    const now = new Date('2026-10-23T00:00:00Z');
    const table: Stored[] = (opts.existing ?? []).map((row, i) => ({
        id: newId(), publicCode: null, name: `Existing ${i}`, slug: `existing-${i}`, description: null,
        heroImageUrl: null, position: i, artistId: ARTIST, organizationId: ORG, isPublic: false,
        isActive: true, archivedAt: null, createdAt: now, updatedAt: now, _count: { drops: 0 }, ...row,
    }) as Stored);
    const liveDrops = opts.liveDrops ?? {};

    const collections = {
        listForArtist: async (artistId: string, status: string) =>
            table
                .filter((r) => r.artistId === artistId)
                .filter((r) => (status === 'live' ? !r.archivedAt : status === 'archived' ? !!r.archivedAt : true))
                .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.position - b.position),
        findForArtist: async (artistId: string, id: string) => table.find((r) => r.id === id && r.artistId === artistId) ?? null,
        countLive: async (artistId: string) => table.filter((r) => r.artistId === artistId && !r.archivedAt).length,
        liveDropCounts: async (ids: string[]) => new Map(ids.filter((id) => liveDrops[id]).map((id) => [id, liveDrops[id]!])),
        slugTaken: async (slug: string, exceptId?: string) => table.some((r) => r.slug === slug && r.id !== exceptId),
        nameTaken: async (artistId: string, name: string, exceptId?: string) =>
            table.some((r) => r.artistId === artistId && !r.archivedAt && r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase()),
        nextPosition: async (artistId: string) =>
            Math.max(-1, ...table.filter((r) => r.artistId === artistId && !r.archivedAt).map((r) => r.position)) + 1,
        create: async (input: Record<string, unknown>) => {
            const row = { id: newId(), publicCode: null, heroImageUrl: null, isActive: true, archivedAt: null, createdAt: now, updatedAt: now, _count: { drops: 0 }, ...input } as Stored;
            table.push(row);
            return row;
        },
        update: async (id: string, data: Record<string, unknown>) => {
            const row = table.find((r) => r.id === id)!;
            Object.assign(row, data);
            return row;
        },
        archive: async (id: string) => {
            const row = table.find((r) => r.id === id && !r.archivedAt);
            if (!row) return 0;
            Object.assign(row, { archivedAt: now, isActive: false, isPublic: false });
            return 1;
        },
        reorder: async (artistId: string, ids: string[]) => {
            ids.forEach((id, position) => {
                const row = table.find((r) => r.id === id && r.artistId === artistId && !r.archivedAt);
                if (row) row.position = position;
            });
        },
    } as unknown as ArtistCollectionRepository;

    const artists = { findByUserId: async (userId: string) => (userId === USER ? me : null) } as unknown as ArtistSelfRepository;

    const asset: ArtistImageAssetRef | null = opts.asset === null ? null : {
        id: ASSET, assetType: 'PROFILE_IMAGE', mimeType: 'image/png', artistId: ARTIST, archived: false,
        virusScanStatus: 'SKIPPED', publicUrl: 'https://cdn.example/profile-images/artists/a/hero.png', ...opts.asset,
    };
    const images: IArtistImageStorage = {
        createUpload: async () => ({ assetId: ASSET, uploadUrl: 'https://s3/put', expiresIn: 300, publicUrl: null }),
        findAsset: async () => asset,
    };

    const published: { event: string; payload: unknown }[] = [];
    const service = new ArtistCollectionService({
        collections,
        artists,
        images: opts.images === false ? undefined : images,
        eventBus: { publish: async (event: string, payload: unknown) => { published.push({ event, payload }); }, subscribe: () => undefined } as never,
        logger: pino({ level: 'silent' }),
    });
    return { service, table, published };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
    }
    throw new Error('expected the call to fail');
}

const create = (body: Record<string, unknown>) => createCollectionSchema.parse(body);

describe('creating a collection', () => {
    it('belongs to the caller, inherits their organization, starts private and goes last', async () => {
        const { service, table, published } = setup({ existing: [{}, {}] });
        const view = await service.create(USER, create({ name: 'Season Two' }));

        expect(view).toMatchObject({ name: 'Season Two', slug: 'kaze-season-two', isPublic: false, position: 2, status: 'LIVE' });
        expect(view.actions).toEqual({ canEdit: true, canArchive: true, archiveBlockedReason: null });
        expect(table.at(-1)).toMatchObject({ artistId: ARTIST, organizationId: ORG });
        expect(published).toEqual([{ event: ARTIST_COLLECTION_EVENTS.CREATED, payload: { collectionId: view.id, artistId: ARTIST } }]);
    });

    it('suffixes a generated slug that is already taken', async () => {
        const { service } = setup({ existing: [{ slug: 'kaze-season-two', name: 'Old', artistId: OTHER_ARTIST }] });
        expect((await service.create(USER, create({ name: 'Season Two' }))).slug).toBe('kaze-season-two-2');
    });

    it('refuses an explicit slug that is taken', async () => {
        const { service } = setup({ existing: [{ slug: 'taken-slug', artistId: OTHER_ARTIST }] });
        const error = await errorOf(service.create(USER, create({ name: 'X', slug: 'taken-slug' })));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.SLUG_TAKEN);
    });

    it('refuses a name the artist already uses (any case) on a live collection', async () => {
        const { service } = setup({ existing: [{ name: 'Season One' }] });
        const error = await errorOf(service.create(USER, create({ name: 'season one' })));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.NAME_TAKEN);
    });

    it('lets a name be reused once the old collection is archived', async () => {
        const { service } = setup({ existing: [{ name: 'Season One', archivedAt: new Date() }] });
        await expect(service.create(USER, create({ name: 'Season One' }))).resolves.toMatchObject({ name: 'Season One' });
    });

    it('stops at the live-collection limit', async () => {
        const { service } = setup({ existing: Array.from({ length: MAX_LIVE_COLLECTIONS_PER_ARTIST }, () => ({})) });
        const error = await errorOf(service.create(USER, create({ name: 'One too many' })));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.LIMIT_REACHED);
    });

    it('is refused for a locked profile, and for an account with no artist profile', async () => {
        const locked = setup({ me: artist({ isActive: false }) });
        expect((await errorOf(locked.service.create(USER, create({ name: 'X' })))).code).toBe(ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED);
        const none = setup({ me: null });
        expect((await errorOf(none.service.create(USER, create({ name: 'X' })))).code).toBe(ARTIST_SELF_ERROR_CODES.PROFILE_NOT_FOUND);
    });

    it('refuses fields the artist does not control', () => {
        for (const field of ['artistId', 'organizationId', 'position', 'isActive', 'heroImageUrl']) {
            expect(createCollectionSchema.safeParse({ name: 'X', [field]: 'x' }).success).toBe(false);
        }
    });
});

describe('editing and reading', () => {
    it('updates the fields sent and publishes which ones changed', async () => {
        const { service, table, published } = setup({ existing: [{}] });
        const id = table[0]!.id;
        const view = await service.update(USER, id, updateCollectionSchema.parse({ description: 'New notes', isPublic: true }));
        expect(view).toMatchObject({ description: 'New notes', isPublic: true });
        expect(published.at(-1)).toEqual({
            event: ARTIST_COLLECTION_EVENTS.UPDATED,
            payload: { collectionId: id, artistId: ARTIST, fields: ['description', 'isPublic'] },
        });
    });

    it('cannot see or touch another artist’s collection — it is simply not found', async () => {
        const { service, table } = setup({ existing: [{ artistId: OTHER_ARTIST }] });
        const id = table[0]!.id;
        expect((await errorOf(service.getMine(USER, id))).code).toBe(ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        expect((await errorOf(service.update(USER, id, updateCollectionSchema.parse({ name: 'Mine now' })))).statusCode).toBe(404);
    });

    it('treats an archived collection as read-only', async () => {
        const { service, table } = setup({ existing: [{ archivedAt: new Date() }] });
        const error = await errorOf(service.update(USER, table[0]!.id, updateCollectionSchema.parse({ name: 'Back' })));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
    });

    it('lists live collections by default, archived ones on request', async () => {
        const { service } = setup({ existing: [{ name: 'A' }, { name: 'B', archivedAt: new Date() }] });
        expect((await service.listMine(USER, { status: 'live' })).map((c) => c.name)).toEqual(['A']);
        expect((await service.listMine(USER, { status: 'all' })).map((c) => c.name)).toEqual(['A', 'B']);
    });
});

describe('deleting (archiving)', () => {
    it('archives an empty collection, takes it off the storefront and closes the gap', async () => {
        const { service, table, published } = setup({ existing: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
        const [a, b, c] = table;
        const view = await service.archive(USER, b!.id);

        expect(view).toMatchObject({ status: 'ARCHIVED', isPublic: false, isActive: false });
        expect(view.actions).toEqual({ canEdit: false, canArchive: false, archiveBlockedReason: 'ARCHIVED' });
        expect([a!.position, c!.position]).toEqual([0, 1]);
        expect(published.at(-1)?.event).toBe(ARTIST_COLLECTION_EVENTS.ARCHIVED);
    });

    it('refuses while drops that are not retired remain in it', async () => {
        const id = '66666666-6666-4666-8666-666666666666';
        const { service, table } = setup({ existing: [{ id }], liveDrops: { [id]: 3 } });
        const error = await errorOf(service.archive(USER, id));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.HAS_DROPS);
        expect(error.details).toEqual({ liveDrops: 3 });
        expect(table[0]!.archivedAt).toBeNull();
        expect((await service.getMine(USER, id)).actions.archiveBlockedReason).toBe('HAS_DROPS');
    });

    it('a second delete is a conflict, not a silent success', async () => {
        const { service, table } = setup({ existing: [{}] });
        await service.archive(USER, table[0]!.id);
        expect((await errorOf(service.archive(USER, table[0]!.id))).code).toBe(ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
    });
});

describe('reordering', () => {
    it('rewrites positions in the order given', async () => {
        const { service, table } = setup({ existing: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
        const [a, b, c] = table.map((r) => r.id);
        const result = await service.reorder(USER, { collectionIds: [c!, a!, b!] });
        expect(result.map((r) => r.name)).toEqual(['C', 'A', 'B']);
    });

    it('needs every live collection exactly once', async () => {
        const { service, table } = setup({ existing: [{}, {}] });
        const error = await errorOf(service.reorder(USER, { collectionIds: [table[0]!.id, '55555555-5555-4555-8555-555555555555'] }));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.ORDER_MISMATCH);
        expect(error.details).toEqual({ missing: [table[1]!.id], unknown: ['55555555-5555-4555-8555-555555555555'] });
    });
});

describe('hero image', () => {
    it('uses an image the artist uploaded', async () => {
        const { service, table } = setup({ existing: [{}] });
        const view = await service.setHero(USER, table[0]!.id, { assetId: ASSET });
        expect(view.heroImageUrl).toBe('https://cdn.example/profile-images/artists/a/hero.png');
    });

    it.each<[string, Partial<ArtistImageAssetRef>]>([
        ['someone else’s upload', { artistId: OTHER_ARTIST }],
        ['a non-image asset', { assetType: 'LEGAL_DOCUMENT' }],
        ['a deleted image', { archived: true }],
        ['an image that failed the scan', { virusScanStatus: 'INFECTED' }],
    ])('refuses %s', async (_label, asset) => {
        const { service, table } = setup({ existing: [{}], asset });
        const error = await errorOf(service.setHero(USER, table[0]!.id, { assetId: ASSET }));
        expect(error.code).toBe(ARTIST_SELF_ERROR_CODES.IMAGE_INVALID);
    });

    it('explains when no storage is configured', async () => {
        const { service, table } = setup({ existing: [{}], images: false });
        const error = await errorOf(service.createHeroUpload(USER, table[0]!.id, { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 10 }));
        expect(error.code).toBe(ARTIST_SELF_ERROR_CODES.IMAGES_UNAVAILABLE);
    });
});

describe('monitoring query', () => {
    it('parses the filters an admin screen sends', () => {
        expect(adminListCollectionsQuerySchema.parse({ isPublic: 'false', empty: 'true', q: 'season', page: '2' })).toMatchObject({
            isPublic: false, empty: true, q: 'season', page: 2, limit: 20, status: 'all', sort: 'newest',
        });
    });
});
