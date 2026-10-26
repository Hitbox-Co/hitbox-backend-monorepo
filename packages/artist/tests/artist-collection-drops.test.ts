import pino from 'pino';
import { AppError } from '@hitbox/shared';
import {
    ARTIST_AUDIT_EVENTS,
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
} from '../src/collection/constants/artist-collection.constant';
import type { IDropCollectionMembership, MembershipDrop } from '../src/collection/domain/drop-membership.port';
import { addDropsSchema, availableDropsQuerySchema } from '../src/collection/dto/artist-collection.dto';
import type { ArtistCollectionRepository, CollectionRow } from '../src/collection/repository/artist-collection.repository';
import { ArtistCollectionService } from '../src/collection/service/artist-collection.service';
import type { ArtistSelfRepository, ArtistSelfRow } from '../src/self/repository/artist-self.repository';

/**
 * An artist filing their own drops into their collections —
 * docs/artist-collection/artist-collection-api.md §10–12.
 * The drop catalog is an in-memory fake of products' adapter.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER_ARTIST = '99999999-9999-4999-8999-999999999999';
const ORG = '33333333-3333-4333-8333-333333333333';
const HERE = 'c1111111-1111-4111-8111-111111111111';
const ELSEWHERE = 'c2222222-2222-4222-8222-222222222222';
const ARCHIVED_SET = 'c3333333-3333-4333-8333-333333333333';

const d = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function drop(n: number, over: Partial<MembershipDrop> = {}): MembershipDrop {
    return {
        id: d(n), publicCode: null, name: `Drop ${n}`, groupCode: `G${n}`, status: 'ACTIVE', active: true,
        artistId: ME, totalSupply: 10, publishedAt: null, collection: null, ...over,
    };
}

function collectionRow(id: string, over: Partial<CollectionRow> = {}): CollectionRow {
    const now = new Date('2026-10-24T00:00:00Z');
    return {
        id, publicCode: null, name: `Set ${id.slice(0, 2)}`, slug: `set-${id.slice(0, 4)}`, description: null,
        heroImageUrl: null, position: 0, artistId: ME, organizationId: ORG, isPublic: true, isActive: true,
        archivedAt: null, createdAt: now, updatedAt: now, _count: { drops: 0 }, ...over,
    } as CollectionRow;
}

function setup(catalog: MembershipDrop[], opts: { raceOnWrite?: boolean; noCatalog?: boolean } = {}) {
    const sets = [collectionRow(HERE), collectionRow(ELSEWHERE, { name: 'Other set' }), collectionRow(ARCHIVED_SET, { archivedAt: new Date() })];
    const drops = new Map(catalog.map((x) => [x.id, { ...x }]));
    const writes: unknown[] = [];

    const membership: IDropCollectionMembership = {
        listAssignable: async ({ artistId, collectionId, includeFiled, skip, take }) => {
            const all = [...drops.values()].filter((x) =>
                x.artistId === artistId && x.active && x.collection?.id !== collectionId &&
                (includeFiled || x.collection === null));
            return { total: all.length, items: all.slice(skip, skip + take) };
        },
        findDrops: async (ids) => ids.map((id) => drops.get(id)).filter((x): x is MembershipDrop => !!x),
        setCollection: async (input) => {
            writes.push(input);
            if (opts.raceOnWrite) return false;
            for (const { id } of input.drops) {
                const row = drops.get(id)!;
                const target = sets.find((s) => s.id === input.collectionId);
                row.collection = target ? { id: target.id, name: target.name } : null;
            }
            return true;
        },
    };

    const collections = {
        findForArtist: async (artistId: string, id: string) => sets.find((s) => s.id === id && s.artistId === artistId) ?? null,
        liveDropCounts: async () => new Map(),
        activeDropCounts: async () => new Map(),
        activeDropsOf: async (id: string) =>
            [...drops.values()].filter((x) => x.collection?.id === id && x.active).map((x) => ({
                id: x.id, publicCode: null, name: x.name, groupCode: x.groupCode, totalSupply: 10,
                publishedAt: null, releaseStart: null, releaseEnd: null,
            })),
    } as unknown as ArtistCollectionRepository;

    const artists = {
        findByUserId: async (userId: string) =>
            userId === USER ? ({ id: ME, slug: 'kaze', organizationId: ORG, isActive: true, archivedAt: null } as ArtistSelfRow) : null,
    } as unknown as ArtistSelfRepository;

    const audited: Record<string, unknown>[] = [];
    const published: { event: string; payload: unknown }[] = [];
    const service = new ArtistCollectionService({
        collections,
        artists,
        drops: opts.noCatalog ? undefined : membership,
        audit: { record: async (input) => { audited.push(input as unknown as Record<string, unknown>); } },
        eventBus: { publish: async (event: string, payload: unknown) => { published.push({ event, payload }); }, subscribe: () => undefined } as never,
        logger: pino({ level: 'silent' }),
    });
    return { service, drops, writes, audited, published };
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

const query = (q: Record<string, string> = {}) => availableDropsQuerySchema.parse(q);
const add = (body: Record<string, unknown>) => addDropsSchema.parse(body);

describe('the "Add drops" picker', () => {
    const catalog = [
        drop(1),                                                       // unfiled, mine, active → listed
        drop(2, { collection: { id: HERE, name: 'Here' } }),           // already here → never listed
        drop(3, { collection: { id: ELSEWHERE, name: 'Other set' } }), // filed elsewhere → only with includeFiled
        drop(4, { artistId: OTHER_ARTIST }),                           // someone else's → never
        drop(5, { active: false, status: 'DRAFT' }),                   // not active → never
    ];

    it('lists only my active drops that are in no collection', async () => {
        const { service } = setup(catalog);
        const page = await service.listAvailableDrops(USER, HERE, query());
        expect(page.items.map((x) => x.id)).toEqual([d(1)]);
        expect(page).toMatchObject({ total: 1, page: 1, limit: 20 });
    });

    it('with includeFiled, adds my drops from other collections and says where they are', async () => {
        const { service } = setup(catalog);
        const page = await service.listAvailableDrops(USER, HERE, query({ includeFiled: 'true' }));
        expect(page.items.map((x) => x.id)).toEqual([d(1), d(3)]);
        expect(page.items[1]!.currentCollection).toEqual({ id: ELSEWHERE, name: 'Other set' });
    });

    it('is refused for a deleted collection, and for someone else’s', async () => {
        const { service } = setup(catalog);
        expect((await errorOf(service.listAvailableDrops(USER, ARCHIVED_SET, query()))).code).toBe(ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
        expect((await errorOf(service.listAvailableDrops(USER, 'c9999999-9999-4999-8999-999999999999', query()))).code)
            .toBe(ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
    });
});

describe('adding drops', () => {
    it('files my active unfiled drops, audits it, and returns the collection with them', async () => {
        const { service, writes, audited, published } = setup([drop(1), drop(2)]);
        const result = await service.addDrops(USER, HERE, add({ dropIds: [d(1), d(2)] }));

        expect(writes).toEqual([{
            drops: [{ id: d(1), expectedCollectionId: null }, { id: d(2), expectedCollectionId: null }],
            artistId: ME, collectionId: HERE, requireActive: true,
        }]);
        expect(result.collection.drops.map((x) => x.id)).toEqual([d(1), d(2)]);
        expect(result.movedFrom).toEqual({});
        expect(audited[0]).toMatchObject({
            eventType: ARTIST_AUDIT_EVENTS.COLLECTION_DROPS_ADD,
            actor: { type: 'ARTIST', id: USER },
            resource: { type: 'ArtistCollection', id: HERE },
            afterState: { drops: [{ dropId: d(1), collectionId: HERE }, { dropId: d(2), collectionId: HERE }] },
        });
        expect(published[0]?.event).toBe(ARTIST_COLLECTION_EVENTS.DROPS_ADDED);
    });

    it('reports every problem at once and writes nothing', async () => {
        const { service, writes, audited } = setup([
            drop(1),
            drop(2, { artistId: OTHER_ARTIST }),
            drop(3, { active: false, status: 'DRAFT' }),
            drop(4, { collection: { id: HERE, name: 'Here' } }),
            drop(5, { collection: { id: ELSEWHERE, name: 'Other set' } }),
        ]);
        const error = await errorOf(service.addDrops(USER, HERE, add({ dropIds: [d(1), d(2), d(3), d(4), d(5), d(6)] })));
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.DROPS_INVALID);
        expect(error.details).toEqual({
            problems: [
                // Someone else's drop reads as NOT_FOUND, same as a missing one.
                { dropId: d(2), problem: 'NOT_FOUND' },
                { dropId: d(3), problem: 'NOT_ACTIVE' },
                { dropId: d(4), problem: 'ALREADY_IN_COLLECTION' },
                { dropId: d(5), problem: 'IN_ANOTHER_COLLECTION', collection: { id: ELSEWHERE, name: 'Other set' } },
                { dropId: d(6), problem: 'NOT_FOUND' },
            ],
        });
        expect(writes).toEqual([]);
        expect(audited).toEqual([]);
    });

    it('moves a drop from another of my collections only with move: true', async () => {
        const { service, writes } = setup([drop(5, { collection: { id: ELSEWHERE, name: 'Other set' } })]);
        const result = await service.addDrops(USER, HERE, add({ dropIds: [d(5)], move: true }));
        expect(writes).toEqual([{ drops: [{ id: d(5), expectedCollectionId: ELSEWHERE }], artistId: ME, collectionId: HERE, requireActive: true }]);
        expect(result.movedFrom).toEqual({ [d(5)]: ELSEWHERE });
    });

    it('turns a drop changing under it into a 409 and audits nothing', async () => {
        const { service, audited } = setup([drop(1)], { raceOnWrite: true });
        const error = await errorOf(service.addDrops(USER, HERE, add({ dropIds: [d(1)] })));
        expect(error.statusCode).toBe(409);
        expect(error.code).toBe(ARTIST_COLLECTION_ERROR_CODES.DROPS_CHANGED);
        expect(audited).toEqual([]);
    });

    it('refuses a deleted collection, and explains when no catalog is wired', async () => {
        expect((await errorOf(setup([drop(1)]).service.addDrops(USER, ARCHIVED_SET, add({ dropIds: [d(1)] })))).code)
            .toBe(ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
        expect((await errorOf(setup([drop(1)], { noCatalog: true }).service.addDrops(USER, HERE, add({ dropIds: [d(1)] })))).code)
            .toBe(ARTIST_COLLECTION_ERROR_CODES.DROPS_UNAVAILABLE);
    });

    it('validates the body', () => {
        expect(addDropsSchema.safeParse({ dropIds: [] }).success).toBe(false);
        expect(addDropsSchema.safeParse({ dropIds: [d(1), d(1)] }).success).toBe(false);
        expect(addDropsSchema.safeParse({ dropIds: Array.from({ length: 51 }, (_, i) => d(i)) }).success).toBe(false);
        expect(addDropsSchema.safeParse({ dropIds: [d(1)], collectionId: HERE }).success).toBe(false);
    });
});

describe('removing a drop', () => {
    it('unfiles my drop from this collection — even one no longer active — and audits it', async () => {
        const { service, writes, audited } = setup([drop(7, { active: false, status: 'ENDED', collection: { id: HERE, name: 'Here' } })]);
        await service.removeDrop(USER, HERE, d(7));
        expect(writes).toEqual([{ drops: [{ id: d(7), expectedCollectionId: HERE }], artistId: ME, collectionId: null, requireActive: false }]);
        expect(audited[0]).toMatchObject({
            eventType: ARTIST_AUDIT_EVENTS.COLLECTION_DROPS_REMOVE,
            afterState: { drops: [{ dropId: d(7), collectionId: null }] },
        });
    });

    it('404s a drop that isn’t in this collection or isn’t mine', async () => {
        const { service } = setup([
            drop(1, { collection: { id: ELSEWHERE, name: 'Other set' } }),
            drop(2, { artistId: OTHER_ARTIST, collection: { id: HERE, name: 'Here' } }),
        ]);
        for (const id of [d(1), d(2), d(3)]) {
            expect((await errorOf(service.removeDrop(USER, HERE, id))).code).toBe(ARTIST_COLLECTION_ERROR_CODES.DROP_NOT_IN_COLLECTION);
        }
    });
});
