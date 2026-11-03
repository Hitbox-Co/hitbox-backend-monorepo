import { AppError } from '@hitbox/shared';
import {
    ARTIST_AUDIT_EVENTS,
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
} from '../src/collection/constants/artist-collection.constant';
import type { CollectionRewardView, ICollectionRewards } from '../src/collection/domain/collection-rewards.port';
import {
    addRewardItemSchema,
    reorderRewardItemsSchema,
    saveRewardSchema,
    updateRewardItemSchema,
} from '../src/collection/dto/collection-reward.dto';
import type { ArtistCollectionRepository, CollectionRow } from '../src/collection/repository/artist-collection.repository';
import { ArtistRewardService } from '../src/collection/service/artist-reward.service';
import { ARTIST_SELF_ERROR_CODES } from '../src/self/constants/artist-self.constant';
import type { ArtistSelfRepository, ArtistSelfRow } from '../src/self/repository/artist-self.repository';

/**
 * The artist panel's side of collection rewards —
 * docs/content/collection-rewards.md §3. The reward rules live in the
 * content module (faked here); this file pins ownership, locks and the audit.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const MINE = 'c1111111-1111-4111-8111-111111111111';
const THEIRS = 'c2222222-2222-4222-8222-222222222222';
const DELETED = 'c3333333-3333-4333-8333-333333333333';

function view(over: Partial<CollectionRewardView> = {}): CollectionRewardView {
    return {
        id: 'r1', collectionId: MINE, name: 'Tour film', description: null, status: 'ON',
        isActive: true, archivedAt: null, items: [], unlockedCount: 0, requiredDrops: 2, ...over,
    };
}

function setup(opts: { artist?: Partial<ArtistSelfRow> | null; reward?: CollectionRewardView | null; noRewards?: boolean } = {}) {
    const audits: { eventType: string; metadata?: Record<string, unknown>; beforeState?: unknown; resource?: unknown }[] = [];
    const events: { name: string; payload: unknown }[] = [];
    let current: CollectionRewardView | null = opts.reward === undefined ? null : opts.reward;
    const calls: string[] = [];

    const rewards: ICollectionRewards = {
        get: async () => current,
        save: async (input) => {
            calls.push('save');
            const created = current === null;
            current = view({ ...(current ?? {}), name: input.name, status: 'ON' });
            return { reward: current, created, restored: false, newlyUnlocked: created ? 3 : 0 };
        },
        remove: async () => { calls.push('remove'); current = view({ ...current!, status: 'REMOVED', archivedAt: 'x' }); return current; },
        createItemUpload: async (input) => {
            calls.push(`upload:${input.uploadedById}`);
            return { assetId: 'a1', uploadUrl: 'u', expiresIn: 300, requiredHeaders: { 'Content-Type': input.mimeType }, kind: 'VIDEO' };
        },
        addItem: async (input) => {
            current = view({ ...current!, items: [{ id: 'i1', assetId: input.assetId, kind: 'VIDEO', title: 'Film', position: 0 }] });
            return current;
        },
        updateItem: async () => current!,
        reorderItems: async () => current!,
        removeItem: async () => { current = view({ ...current!, items: [] }); return current; },
    };

    const collections = {
        findForArtist: async (artistId: string, id: string) => {
            if (artistId !== ME) return null;
            if (id === MINE) return { id: MINE, artistId: ME, organizationId: ORG, archivedAt: null } as CollectionRow;
            if (id === DELETED) return { id: DELETED, artistId: ME, organizationId: ORG, archivedAt: new Date() } as CollectionRow;
            return null; // THEIRS belongs to someone else
        },
    } as unknown as ArtistCollectionRepository;
    const artists = {
        findByUserId: async () =>
            opts.artist === null ? null : ({ id: ME, isActive: true, archivedAt: null, ...opts.artist } as ArtistSelfRow),
    } as unknown as ArtistSelfRepository;

    const service = new ArtistRewardService({
        collections,
        artists,
        rewards: opts.noRewards ? undefined : rewards,
        audit: { record: async (input) => { audits.push(input as (typeof audits)[number]); } },
        eventBus: { publish: async (name: string, payload: unknown) => { events.push({ name, payload }); }, subscribe: () => undefined } as never,
    });
    return { service, audits, events, calls };
}

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
    }
    return 'NO_ERROR';
}

describe('whose collection', () => {
    it('another artist’s collection is a 404, the same as a missing one', async () => {
        const { service } = setup({ reward: view() });
        expect(await code(service.get(USER, THEIRS))).toBe(ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        expect(await code(service.save(USER, THEIRS, { name: 'x' }))).toBe(ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
    });

    it('no artist profile is a 404', async () => {
        const { service } = setup({ artist: null });
        expect(await code(service.get(USER, MINE))).toBe(ARTIST_SELF_ERROR_CODES.PROFILE_NOT_FOUND);
    });

    it('a deleted collection can be read but not changed', async () => {
        const { service } = setup({ reward: view({ collectionId: DELETED }) });
        expect((await service.get(USER, DELETED))?.id).toBe('r1');
        expect(await code(service.save(USER, DELETED, { name: 'x' }))).toBe(ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
    });

    it('a deactivated or archived profile can read but not change', async () => {
        for (const artist of [{ isActive: false }, { archivedAt: new Date() }]) {
            const { service } = setup({ artist, reward: view() });
            expect((await service.get(USER, MINE))?.id).toBe('r1');
            expect(await code(service.save(USER, MINE, { name: 'x' }))).toBe(ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED);
        }
    });

    it('without the content module every route answers REWARDS_UNAVAILABLE', async () => {
        const { service } = setup({ noRewards: true });
        expect(await code(service.get(USER, MINE))).toBe(ARTIST_COLLECTION_ERROR_CODES.REWARDS_UNAVAILABLE);
    });
});

describe('changes are audited and announced', () => {
    it('creating the reward: audited with the buyers it unlocked for, and published', async () => {
        const { service, audits, events } = setup();
        const reward = await service.save(USER, MINE, { name: 'Tour film' });
        expect(reward.status).toBe('ON');
        expect(audits[0]).toMatchObject({
            eventType: ARTIST_AUDIT_EVENTS.REWARD_SAVE,
            resource: { type: 'ContentBundle', id: 'r1' },
            beforeState: null,
            metadata: { artistId: ME, collectionId: MINE, created: true, newlyUnlocked: 3, fields: ['name'] },
        });
        expect(events[0]).toEqual({
            name: ARTIST_COLLECTION_EVENTS.REWARD_SAVED,
            payload: { collectionId: MINE, artistId: ME, rewardId: 'r1', status: 'ON', itemCount: 0 },
        });
    });

    it('adding and removing files: audited with the asset and kind', async () => {
        const { service, audits } = setup({ reward: view() });
        await service.addItem(USER, MINE, { assetId: 'a1', title: 'Film' });
        await service.removeItem(USER, MINE, 'i1');
        expect(audits.map((a) => a.eventType)).toEqual([ARTIST_AUDIT_EVENTS.REWARD_ITEM_ADD, ARTIST_AUDIT_EVENTS.REWARD_ITEM_REMOVE]);
        expect(audits[0]!.metadata).toMatchObject({ assetId: 'a1', itemId: 'i1', kind: 'VIDEO' });
        expect(audits[1]!.metadata).toMatchObject({ itemId: 'i1', assetId: 'a1' });
    });

    it('rename and reorder are item updates, told apart by metadata.action', async () => {
        const { service, audits } = setup({ reward: view() });
        await service.updateItem(USER, MINE, 'i1', { title: 'New' });
        await service.reorderItems(USER, MINE, { itemIds: ['i1'] });
        expect(audits.map((a) => [a.eventType, a.metadata?.action])).toEqual([
            [ARTIST_AUDIT_EVENTS.REWARD_ITEM_UPDATE, 'rename'],
            [ARTIST_AUDIT_EVENTS.REWARD_ITEM_UPDATE, 'reorder'],
        ]);
    });

    it('removing the reward is audited once; removing it again changes nothing', async () => {
        const { service, audits } = setup({ reward: view() });
        await service.remove(USER, MINE);
        await service.remove(USER, MINE);
        expect(audits.map((a) => a.eventType)).toEqual([ARTIST_AUDIT_EVENTS.REWARD_REMOVE]);
    });

    it('changing files of a collection with no reward is a 404', async () => {
        const { service } = setup();
        expect(await code(service.addItem(USER, MINE, { assetId: 'a1' }))).toBe(ARTIST_COLLECTION_ERROR_CODES.REWARD_NOT_FOUND);
    });

    it('the upload URL is issued as the caller, and is not audited (nothing changed yet)', async () => {
        const { service, audits, calls } = setup({ reward: view() });
        await service.createItemUpload(USER, MINE, { fileName: 'f.mp4', mimeType: 'video/mp4', sizeBytes: 10 });
        expect(calls).toEqual([`upload:${USER}`]);
        expect(audits).toHaveLength(0);
    });
});

describe('request bodies', () => {
    it('save: a name, optional description and on/off; nothing else', () => {
        expect(saveRewardSchema.parse({ name: ' Tour film ', description: '', isActive: 'false' })).toEqual({
            name: 'Tour film', description: null, isActive: false,
        });
        expect(saveRewardSchema.safeParse({}).success).toBe(false);
        expect(saveRewardSchema.safeParse({ name: 'x', accessType: 'OWNER_ONLY' }).success).toBe(false);
    });

    it('items: a real asset id, titles cleared with null or ""', () => {
        expect(addRewardItemSchema.safeParse({ assetId: 'not-a-uuid' }).success).toBe(false);
        expect(updateRewardItemSchema.parse({ title: '' })).toEqual({ title: null });
        expect(reorderRewardItemsSchema.safeParse({ itemIds: [] }).success).toBe(false);
    });
});
