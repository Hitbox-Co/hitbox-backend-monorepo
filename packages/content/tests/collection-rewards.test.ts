import pino from 'pino';
import { AppError } from '@hitbox/shared';
import { CONTENT_ERROR_CODES, CONTENT_EVENTS, MAX_REWARD_ITEMS } from '../src/constants/content.constant';
import { rewardKindOf } from '../src/domain/reward-kind';
import type { IRewardMedia, RewardMediaAsset } from '../src/domain/reward-media.port';
import type { ContentRepository, RewardRow } from '../src/repository/content.repository';
import { CollectionRewardService } from '../src/service/collection-reward.service';
import { RewardUnlockService } from '../src/service/reward-unlock.service';

/**
 * Collection rewards — docs/content/collection-rewards.md. An in-memory
 * stand-in for the repository: drops of one collection, who owns a claimed
 * unit of what, the reward and its grants.
 */

const COLLECTION = 'c0000000-0000-4000-8000-000000000001';
const OTHER_COLLECTION = 'c0000000-0000-4000-8000-000000000002';
const BUYER = 'b0000000-0000-4000-8000-000000000001';
const BUYER_2 = 'b0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-03T12:00:00Z');
const D1 = 'd1'; const D2 = 'd2'; const D3 = 'd3';

interface World {
    drops: { id: string; name: string; collectionId: string; released: boolean }[];
    /** userId -> dropIds they own a claimed unit of (with counts). */
    owns: Map<string, Map<string, number>>;
    reward: RewardRow | null;
    grants: Map<string, { grantedAt: Date; accessExpiresAt: Date | null; acknowledgedAt: Date | null }>;
    assets: RewardMediaAsset[];
}

function world(): World {
    return {
        drops: [
            { id: D1, name: 'Tee', collectionId: COLLECTION, released: true },
            { id: D2, name: 'Poster', collectionId: COLLECTION, released: true },
            { id: D3, name: 'Draft hoodie', collectionId: COLLECTION, released: false },
        ],
        owns: new Map(),
        reward: null,
        grants: new Map(),
        assets: [],
    };
}

const own = (w: World, userId: string, dropId: string, n = 1) => {
    const mine = w.owns.get(userId) ?? new Map<string, number>();
    mine.set(dropId, (mine.get(dropId) ?? 0) + n);
    w.owns.set(userId, mine);
};

function rewardRow(over: Partial<RewardRow> = {}): RewardRow {
    return {
        id: 'r1', publicCode: 'cbd1', name: 'Tour film', description: null, collectionId: COLLECTION,
        isActive: true, archivedAt: null, createdAt: NOW, updatedAt: NOW,
        collection: {
            id: COLLECTION, name: 'Season One', slug: 'season-one', heroImageUrl: null, archivedAt: null,
            artist: { id: 'a1', name: 'Kaze', slug: 'kaze' },
        },
        contentBundleItems: [],
        ...over,
    } as RewardRow;
}

function fakeRepo(w: World): ContentRepository {
    const live = (g: { accessExpiresAt: Date | null } | undefined, now: Date) =>
        g !== undefined && (g.accessExpiresAt === null || g.accessExpiresAt > now);
    const released = (collectionId: string) => w.drops.filter((d) => d.collectionId === collectionId && d.released);
    return {
        findRewardOfCollection: async (collectionId: string) =>
            w.reward && w.reward.collectionId === collectionId ? structuredClone(w.reward) : null,
        findReward: async (id: string) => (w.reward && w.reward.id === id ? structuredClone(w.reward) : null),
        createReward: async (input: { name: string; description: string | null; isActive: boolean; collectionId: string }) => {
            w.reward = rewardRow({ name: input.name, description: input.description, isActive: input.isActive, collectionId: input.collectionId });
            return structuredClone(w.reward);
        },
        updateReward: async (_id: string, data: Partial<RewardRow>) => {
            w.reward = { ...w.reward!, ...data } as RewardRow;
            return structuredClone(w.reward);
        },
        addItem: async (input: { assetId: string; title: string | null }) => {
            const asset = w.assets.find((a) => a.id === input.assetId)!;
            w.reward!.contentBundleItems.push({
                id: `i-${input.assetId}`, publicCode: null, assetId: input.assetId,
                position: w.reward!.contentBundleItems.length, title: input.title,
                asset: { fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, archivedAt: null },
            });
        },
        updateItemTitle: async (itemId: string, title: string | null) => {
            w.reward!.contentBundleItems.find((i) => i.id === itemId)!.title = title;
        },
        reorderItems: async (_b: string, itemIds: string[]) => {
            w.reward!.contentBundleItems = itemIds.map((id, position) => ({
                ...w.reward!.contentBundleItems.find((i) => i.id === id)!, position,
            }));
        },
        removeItem: async (_b: string, itemId: string) => {
            w.reward!.contentBundleItems = w.reward!.contentBundleItems
                .filter((i) => i.id !== itemId)
                .map((i, position) => ({ ...i, position }));
        },
        releasedDrops: async (collectionId: string) =>
            released(collectionId).map((d) => ({ id: d.id, name: d.name, publicCode: null })),
        ownedDropIds: async (userId: string, dropIds: string[]) =>
            new Set([...(w.owns.get(userId)?.entries() ?? [])].filter(([d, n]) => n > 0 && dropIds.includes(d)).map(([d]) => d)),
        ownsDrop: async (userId: string, dropId: string) => (w.owns.get(userId)?.get(dropId) ?? 0) > 0,
        collectionOfDrop: async (dropId: string) => w.drops.find((d) => d.id === dropId)?.collectionId ?? null,
        completers: async (collectionId: string) => {
            const need = released(collectionId).map((d) => d.id);
            if (need.length === 0) return [];
            return [...w.owns.entries()]
                .filter(([, mine]) => need.every((d) => (mine.get(d) ?? 0) > 0))
                .map(([u]) => u);
        },
        findGrant: async (userId: string) => {
            const g = w.grants.get(userId);
            return g ? { id: userId, ...g } : null;
        },
        hasLiveGrant: async (userId: string, _b: string, now: Date) => live(w.grants.get(userId), now),
        grant: async (userId: string, _b: string, now: Date) => {
            const g = w.grants.get(userId);
            if (live(g, now)) return false;
            w.grants.set(userId, { grantedAt: now, accessExpiresAt: null, acknowledgedAt: g?.acknowledgedAt ?? null });
            return true;
        },
        grantMany: async (userIds: string[], _b: string, now: Date) => {
            const opened = userIds.filter((u) => !live(w.grants.get(u), now));
            for (const u of opened) w.grants.set(u, { grantedAt: now, accessExpiresAt: null, acknowledgedAt: null });
            return opened;
        },
        endGrant: async (userId: string, _b: string, now: Date) => {
            const g = w.grants.get(userId);
            if (!live(g, now)) return false;
            g!.accessExpiresAt = now;
            return true;
        },
        countLiveGrants: async (_b: string, now: Date) => [...w.grants.values()].filter((g) => live(g, now)).length,
        recordView: async (userId: string) => {
            const g = w.grants.get(userId);
            if (g && !g.acknowledgedAt) g.acknowledgedAt = NOW;
        },
        myLiveRewards: async (userId: string, now: Date) =>
            live(w.grants.get(userId), now) && w.reward
                ? [{ grantedAt: w.grants.get(userId)!.grantedAt, bundle: structuredClone(w.reward) }]
                : [],
    } as unknown as ContentRepository;
}

function setup(opts: { media?: boolean } = {}) {
    const w = world();
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const uploads: Record<string, unknown>[] = [];
    const media: IRewardMedia = {
        createUpload: async (input) => {
            uploads.push(input);
            return { assetId: 'new-asset', uploadUrl: 'https://s3/put', expiresIn: 300, requiredHeaders: { 'Content-Type': input.mimeType } };
        },
        inspect: async (ids) => w.assets.filter((a) => ids.includes(a.id)),
        links: async (ids) => ids.map((assetId) => ({ assetId, url: `https://s3/get/${assetId}`, expiresIn: 3600 })),
    };
    const content = fakeRepo(w);
    const eventBus = {
        publish: async (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); },
        subscribe: () => undefined,
    } as never;
    const unlocks = new RewardUnlockService({
        content, media: opts.media === false ? undefined : media, eventBus, logger: pino({ level: 'silent' }), now: () => NOW,
    });
    const rewards = new CollectionRewardService({
        content, unlocks, media: opts.media === false ? undefined : media, now: () => NOW,
    });
    return { w, unlocks, rewards, events, uploads };
}

const asset = (over: Partial<RewardMediaAsset> = {}): RewardMediaAsset => ({
    id: 'asset-1', collectionId: COLLECTION, fileName: 'tour-film.mp4', mimeType: 'video/mp4', sizeBytes: 1000,
    uploadedById: 'artist-user', archived: false, infected: false, uploaded: true, ...over,
});

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
    }
    return 'NO_ERROR';
}

describe('what a reward file may be', () => {
    it.each([
        ['video/mp4', 'VIDEO'], ['video/webm', 'VIDEO'], ['video/quicktime', 'VIDEO'],
        ['audio/mpeg', 'AUDIO'], ['audio/wav', 'AUDIO'], ['audio/flac', 'AUDIO'],
        ['image/gif', 'GIF'], ['image/png', 'IMAGE'], ['IMAGE/JPEG', 'IMAGE'],
    ])('%s is %s', (mime, kind) => {
        expect(rewardKindOf(mime)).toBe(kind);
    });

    it('anything else is not reward content', () => {
        expect(rewardKindOf('application/pdf')).toBeNull();
        expect(rewardKindOf('application/zip')).toBeNull();
    });
});

describe('the rule: collect every released drop to unlock', () => {
    it('unlocks on the claim that completes the set — drafts do not count', async () => {
        const { w, unlocks, events } = setup();
        w.reward = rewardRow();
        own(w, BUYER, D1);
        expect(await unlocks.onClaimed({ userId: BUYER, productId: D1 })).toBe(false);

        own(w, BUYER, D2);
        expect(await unlocks.onClaimed({ userId: BUYER, productId: D2 })).toBe(true);
        expect(events).toEqual([
            { name: CONTENT_EVENTS.REWARD_UNLOCKED, payload: { rewardId: 'r1', collectionId: COLLECTION, userId: BUYER } },
        ]);
        // A second claim of the same set changes nothing and announces nothing.
        own(w, BUYER, D2);
        expect(await unlocks.onClaimed({ userId: BUYER, productId: D2 })).toBe(false);
        expect(events).toHaveLength(1);
    });

    it('does not unlock a reward that is paused, removed, or on a deleted collection', async () => {
        for (const reward of [
            rewardRow({ isActive: false }),
            rewardRow({ archivedAt: NOW }),
            rewardRow({ collection: { ...rewardRow().collection!, archivedAt: NOW } }),
        ]) {
            const { w, unlocks } = setup();
            w.reward = reward;
            own(w, BUYER, D1); own(w, BUYER, D2);
            expect(await unlocks.onClaimed({ userId: BUYER, productId: D2 })).toBe(false);
        }
    });

    it('a claim outside any collection, or in a collection with no reward, does nothing', async () => {
        const { w, unlocks } = setup();
        w.drops.push({ id: 'loose', name: 'Loose', collectionId: OTHER_COLLECTION, released: true });
        expect(await unlocks.onClaimed({ userId: BUYER, productId: 'unknown' })).toBe(false);
        expect(await unlocks.onClaimed({ userId: BUYER, productId: 'loose' })).toBe(false);
    });

    it('a collection with no released drops can never be completed', async () => {
        const { w, unlocks } = setup();
        w.reward = rewardRow();
        w.drops = [{ id: D3, name: 'Draft', collectionId: COLLECTION, released: false }];
        expect(await unlocks.evaluate(BUYER, COLLECTION)).toBe(false);
    });

    it('losing a piece (refund) ends access — unless they still own another unit of it', async () => {
        const { w, unlocks, events } = setup();
        w.reward = rewardRow();
        own(w, BUYER, D1, 2); own(w, BUYER, D2);
        await unlocks.evaluate(BUYER, COLLECTION);

        // One of two tees refunded: still holds the set.
        w.owns.get(BUYER)!.set(D1, 1);
        expect(await unlocks.onClaimRevoked({ userId: BUYER, productId: D1 })).toBe(false);

        // The last tee refunded: access ends.
        w.owns.get(BUYER)!.set(D1, 0);
        expect(await unlocks.onClaimRevoked({ userId: BUYER, productId: D1 })).toBe(true);
        expect(events.at(-1)).toMatchObject({ name: CONTENT_EVENTS.REWARD_ACCESS_LOST, payload: { userId: BUYER } });
        expect(await code(unlocks.getMine(BUYER, 'r1'))).toBe(CONTENT_ERROR_CODES.REWARD_LOCKED);

        // Completing the set again brings it back.
        own(w, BUYER, D1);
        expect(await unlocks.onClaimed({ userId: BUYER, productId: D1 })).toBe(true);
        expect((await unlocks.getMine(BUYER, 'r1')).id).toBe('r1');
    });

    it('a revocation that names no owner is ignored', async () => {
        const { unlocks } = setup();
        expect(await unlocks.onClaimRevoked({ userId: null, productId: D1 })).toBe(false);
    });

    it('a drop added later does not take an unlock away', async () => {
        const { w, unlocks } = setup();
        w.reward = rewardRow();
        own(w, BUYER, D1); own(w, BUYER, D2);
        await unlocks.evaluate(BUYER, COLLECTION);
        w.drops.push({ id: 'd4', name: 'New cap', collectionId: COLLECTION, released: true });
        expect((await unlocks.listMine(BUYER)).map((r) => r.id)).toEqual(['r1']);
    });
});

describe('the buyer: list, open, teaser', () => {
    it('opens an unlocked reward with signed links, and records the view', async () => {
        const { w, unlocks } = setup();
        w.assets.push(asset());
        w.reward = rewardRow({
            contentBundleItems: [{
                id: 'i1', publicCode: null, assetId: 'asset-1', position: 0, title: null,
                asset: { fileName: 'tour-film.mp4', mimeType: 'video/mp4', sizeBytes: 1000, archivedAt: null },
            }],
        });
        own(w, BUYER, D1); own(w, BUYER, D2);
        await unlocks.evaluate(BUYER, COLLECTION);

        const detail = await unlocks.getMine(BUYER, 'r1');
        expect(detail.items).toEqual([expect.objectContaining({
            kind: 'VIDEO', title: 'tour-film.mp4', url: 'https://s3/get/asset-1', expiresIn: 3600,
        })]);
        expect(detail.itemCounts).toEqual({ VIDEO: 1, AUDIO: 0, GIF: 0, IMAGE: 0 });
        expect(w.grants.get(BUYER)!.acknowledgedAt).toEqual(NOW);
    });

    it('a locked reward is 403 LOCKED with the collection id; a missing or paused one is 404', async () => {
        const { w, unlocks } = setup();
        w.reward = rewardRow();
        const locked = await unlocks.getMine(BUYER, 'r1').catch((e: AppError) => e);
        expect(locked).toMatchObject({ statusCode: 403, code: CONTENT_ERROR_CODES.REWARD_LOCKED, details: { collectionId: COLLECTION } });
        expect(await code(unlocks.getMine(BUYER, 'nope'))).toBe(CONTENT_ERROR_CODES.REWARD_NOT_FOUND);
        w.reward = rewardRow({ isActive: false });
        expect(await code(unlocks.getMine(BUYER, 'r1'))).toBe(CONTENT_ERROR_CODES.REWARD_NOT_FOUND);
    });

    it('the teaser shows progress and what is missing — counts per kind, never the files', async () => {
        const { w, unlocks } = setup();
        w.reward = rewardRow();
        own(w, BUYER, D1);
        const teaser = await unlocks.teaser(BUYER, COLLECTION);
        expect(teaser.progress).toEqual({
            required: 2, collected: 1, complete: false,
            missing: [{ dropId: D2, publicCode: null, name: 'Poster' }],
        });
        expect(teaser.unlocked).toBe(false);
        expect(teaser.reward).not.toHaveProperty('items');
    });

    it('the teaser grants a buyer who holds the set but was never granted', async () => {
        const { w, unlocks } = setup();
        w.reward = rewardRow();
        own(w, BUYER, D1); own(w, BUYER, D2);
        expect((await unlocks.teaser(BUYER, COLLECTION)).unlocked).toBe(true);
        expect(w.grants.has(BUYER)).toBe(true);
    });
});

describe('the artist: managing the reward', () => {
    it('creating a reward unlocks it at once for everyone who already holds the set', async () => {
        const { w, rewards, events } = setup();
        own(w, BUYER, D1); own(w, BUYER, D2);
        own(w, BUYER_2, D1);

        const result = await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        expect(result).toMatchObject({ created: true, restored: false, newlyUnlocked: 1 });
        expect(result.reward).toMatchObject({ status: 'ON', unlockedCount: 1, requiredDrops: 2 });
        expect(events.map((e) => e.payload.userId)).toEqual([BUYER]);
    });

    it('a paused reward grants nobody until it is switched on', async () => {
        const { w, rewards } = setup();
        own(w, BUYER, D1); own(w, BUYER, D2);
        expect((await rewards.save({ collectionId: COLLECTION, name: 'Soon', isActive: false })).newlyUnlocked).toBe(0);
        expect((await rewards.save({ collectionId: COLLECTION, name: 'Soon', isActive: true })).newlyUnlocked).toBe(1);
        // Already on: a plain edit grants nobody again.
        expect((await rewards.save({ collectionId: COLLECTION, name: 'Renamed' })).newlyUnlocked).toBe(0);
    });

    it('removing keeps it; saving again restores it', async () => {
        const { rewards } = setup();
        await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        expect((await rewards.remove(COLLECTION)).status).toBe('REMOVED');
        const back = await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        expect(back).toMatchObject({ created: false, restored: true });
        expect(back.reward.status).toBe('ON');
    });

    it('upload: only video, music, GIF or image, within the size for its kind', async () => {
        const { rewards, uploads } = setup();
        await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        const base = { collectionId: COLLECTION, uploadedById: 'artist-user', fileName: 'x' };

        const ticket = await rewards.createItemUpload({ ...base, mimeType: 'video/mp4', sizeBytes: 10_000 });
        expect(ticket).toMatchObject({ kind: 'VIDEO', uploadUrl: 'https://s3/put' });
        expect(uploads[0]).toMatchObject({ collectionId: COLLECTION, mimeType: 'video/mp4' });

        expect(await code(rewards.createItemUpload({ ...base, mimeType: 'application/pdf', sizeBytes: 10 })))
            .toBe(CONTENT_ERROR_CODES.FILE_TYPE);
        expect(await code(rewards.createItemUpload({ ...base, mimeType: 'image/png', sizeBytes: 26 * 1024 * 1024 })))
            .toBe(CONTENT_ERROR_CODES.FILE_TYPE);
    });

    it('upload needs a reward, a live one, and a bucket', async () => {
        const input = { collectionId: COLLECTION, uploadedById: 'u', fileName: 'x', mimeType: 'video/mp4', sizeBytes: 1 };
        const none = setup();
        expect(await code(none.rewards.createItemUpload(input))).toBe(CONTENT_ERROR_CODES.REWARD_NOT_FOUND);

        const removed = setup();
        await removed.rewards.save({ collectionId: COLLECTION, name: 'x' });
        await removed.rewards.remove(COLLECTION);
        expect(await code(removed.rewards.createItemUpload(input))).toBe(CONTENT_ERROR_CODES.REWARD_ARCHIVED);

        const noBucket = setup({ media: false });
        await noBucket.rewards.save({ collectionId: COLLECTION, name: 'x' });
        expect(await code(noBucket.rewards.createItemUpload(input))).toBe(CONTENT_ERROR_CODES.MEDIA_UNAVAILABLE);
    });

    it('adding a file checks it is this collection’s, uploaded, clean and reward content', async () => {
        const { w, rewards } = setup();
        await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        w.assets.push(
            asset(),
            asset({ id: 'elsewhere', collectionId: OTHER_COLLECTION }),
            asset({ id: 'pending', uploaded: false }),
            asset({ id: 'infected', infected: true }),
            asset({ id: 'deleted', archived: true }),
            asset({ id: 'pdf', mimeType: 'application/pdf' }),
        );

        const view = await rewards.addItem({ collectionId: COLLECTION, assetId: 'asset-1', title: 'The tour film' });
        expect(view.items).toEqual([expect.objectContaining({ title: 'The tour film', kind: 'VIDEO', position: 0 })]);

        for (const id of ['missing', 'elsewhere', 'pending', 'infected', 'deleted', 'pdf']) {
            expect(await code(rewards.addItem({ collectionId: COLLECTION, assetId: id }))).toBe(CONTENT_ERROR_CODES.FILE_INVALID);
        }
        expect(await code(rewards.addItem({ collectionId: COLLECTION, assetId: 'asset-1' }))).toBe(CONTENT_ERROR_CODES.FILE_DUPLICATE);
    });

    it(`holds at most ${MAX_REWARD_ITEMS} files`, async () => {
        const { w, rewards } = setup();
        await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        w.reward!.contentBundleItems = Array.from({ length: MAX_REWARD_ITEMS }, (_, n) => ({
            id: `i${n}`, publicCode: null, assetId: `a${n}`, position: n, title: null,
            asset: { fileName: `f${n}.png`, mimeType: 'image/png', sizeBytes: 1, archivedAt: null },
        }));
        w.assets.push(asset());
        expect(await code(rewards.addItem({ collectionId: COLLECTION, assetId: 'asset-1' }))).toBe(CONTENT_ERROR_CODES.TOO_MANY_ITEMS);
    });

    it('renames, reorders (every item, once) and removes files', async () => {
        const { w, rewards } = setup();
        await rewards.save({ collectionId: COLLECTION, name: 'Tour film' });
        w.assets.push(asset(), asset({ id: 'asset-2', fileName: 'poster.png', mimeType: 'image/png' }));
        await rewards.addItem({ collectionId: COLLECTION, assetId: 'asset-1' });
        await rewards.addItem({ collectionId: COLLECTION, assetId: 'asset-2' });

        expect((await rewards.updateItem({ collectionId: COLLECTION, itemId: 'i-asset-2', title: 'Poster' })).items[1]!.title).toBe('Poster');
        const reordered = await rewards.reorderItems({ collectionId: COLLECTION, itemIds: ['i-asset-2', 'i-asset-1'] });
        expect(reordered.items.map((i) => i.id)).toEqual(['i-asset-2', 'i-asset-1']);
        expect(await code(rewards.reorderItems({ collectionId: COLLECTION, itemIds: ['i-asset-2'] }))).toBe(CONTENT_ERROR_CODES.ORDER_MISMATCH);

        const after = await rewards.removeItem({ collectionId: COLLECTION, itemId: 'i-asset-2' });
        expect(after.items.map((i) => [i.id, i.position])).toEqual([['i-asset-1', 0]]);
        expect(await code(rewards.removeItem({ collectionId: COLLECTION, itemId: 'nope' }))).toBe(CONTENT_ERROR_CODES.ITEM_NOT_FOUND);
    });
});
