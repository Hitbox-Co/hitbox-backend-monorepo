import pino from 'pino';
import { AppError } from '@hitbox/shared';
import { CONTENT_AUDIT_EVENTS, CONTENT_ERROR_CODES, CONTENT_EVENTS } from '../src/constants/content.constant';
import {
    adminListRewardsQuerySchema,
    moderationLiftSchema,
    moderationTakedownSchema,
} from '../src/controller/admin-reward.controller';
import type { ContentRepository, RewardRow } from '../src/repository/content.repository';
import { AdminRewardService } from '../src/service/admin-reward.service';
import { CollectionRewardService } from '../src/service/collection-reward.service';
import { RewardUnlockService } from '../src/service/reward-unlock.service';

/**
 * HitBox staff over collection rewards — docs/content/admin-rewards-api.md.
 * Moderation is a lock: staff switch-off / removal can only be lifted by staff.
 */

const NOW = new Date('2026-11-03T12:00:00Z');
const STAFF = { userId: 'staff-1', roleName: 'HITBOX_SYSTEM_ADMIN' };
const COLLECTION = 'c0000000-0000-4000-8000-000000000001';

function rewardRow(over: Partial<RewardRow> = {}): RewardRow {
    return {
        id: 'r1', publicCode: 'cbd1', name: 'Tour film', description: 'Unseen footage', collectionId: COLLECTION,
        isActive: true, archivedAt: null, createdAt: NOW, updatedAt: NOW,
        moderationLockedAt: null, moderationReason: null, moderatedById: null,
        collection: {
            id: COLLECTION, name: 'Season One', slug: 'season-one', heroImageUrl: null, archivedAt: null,
            organizationId: 'org-1', artist: { id: 'a1', name: 'Kaze', slug: 'kaze' },
        },
        contentBundleItems: [{
            id: 'i1', publicCode: null, assetId: 'asset-1', position: 0, title: null,
            asset: { fileName: 'film.mp4', mimeType: 'video/mp4', sizeBytes: 10, archivedAt: null },
        }],
        ...over,
    } as RewardRow;
}

function setup(initial: RewardRow | null = rewardRow(), completers: string[] = []) {
    let reward = initial;
    const audits: { eventType: string; metadata?: Record<string, unknown>; actor?: unknown; beforeState?: unknown; afterState?: unknown }[] = [];
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const granted: string[] = [];

    const content = {
        findReward: async (id: string) => (reward && reward.id === id ? structuredClone(reward) : null),
        findRewardOfCollection: async () => (reward ? structuredClone(reward) : null),
        updateReward: async (_id: string, data: Partial<RewardRow>) => {
            reward = { ...reward!, ...data } as RewardRow;
            return structuredClone(reward);
        },
        liveGrantCounts: async (ids: string[]) => new Map(ids.map((id) => [id, 7])),
        releasedDrops: async () => [{ id: 'd1', name: 'Tee', publicCode: null }, { id: 'd2', name: 'Poster', publicCode: null }],
        countLiveGrants: async () => 7,
        completers: async () => completers,
        grantMany: async (userIds: string[]) => { granted.push(...userIds); return userIds; },
        adminList: async (filter: Record<string, unknown>) => {
            lastFilter = filter;
            return { total: reward ? 1 : 0, items: reward ? [structuredClone(reward)] : [] };
        },
        adminCounts: async () => ({
            total: 3, on: 1, off: 1, removed: 1, locked: 1, liveUnlocks: 40, unlocksThisMonth: 9, buyersWithRewards: 31,
        }),
        topByUnlocks: async () => [{ bundleId: 'r1', unlocks: 25 }, { bundleId: 'gone', unlocks: 3 }],
        findRewards: async (ids: string[]) => (reward && ids.includes(reward.id) ? [structuredClone(reward)] : []),
        listUnlocks: async () => ({
            total: 2,
            items: [
                {
                    id: 'u1', publicCode: 'cul1', grantedAt: NOW, accessExpiresAt: null, acknowledgedAt: NOW,
                    lastAccessedAt: NOW, accessCount: 4, user: { id: 'b1', handle: 'mia', fullName: 'Mia' },
                },
                {
                    id: 'u2', publicCode: 'cul2', grantedAt: NOW, accessExpiresAt: new Date('2026-11-02T00:00:00Z'),
                    acknowledgedAt: null, lastAccessedAt: null, accessCount: 0, user: { id: 'b2', handle: null, fullName: null },
                },
            ],
        }),
    } as unknown as ContentRepository;
    let lastFilter: Record<string, unknown> = {};

    const eventBus = {
        publish: async (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); },
        subscribe: () => undefined,
    } as never;
    const logger = pino({ level: 'silent' });
    const unlocks = new RewardUnlockService({ content, eventBus, logger, now: () => NOW });
    const media = {
        createUpload: async () => { throw new Error('unused'); },
        inspect: async () => [],
        links: async (ids: string[]) => ids.map((assetId) => ({ assetId, url: `https://s3/get/${assetId}`, expiresIn: 3600 })),
    };
    const admin = new AdminRewardService({
        content, unlocks, media, eventBus, logger, now: () => NOW,
        audit: { record: async (input) => { audits.push(input as (typeof audits)[number]); } },
    });
    const artist = new CollectionRewardService({ content, unlocks, media, now: () => NOW });
    return { admin, artist, audits, events, granted, current: () => reward, filter: () => lastFilter };
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

describe('monitoring', () => {
    it('lists rewards with file counts, live unlocks and moderation state', async () => {
        const { admin, filter } = setup();
        const page = await admin.list(adminListRewardsQuerySchema.parse({ status: 'ON', q: 'tour', page: '2', limit: '10' }));
        expect(filter()).toMatchObject({ status: 'ON', q: 'tour', skip: 10, take: 10 });
        expect(page.items[0]).toMatchObject({
            id: 'r1', status: 'ON', unlockedCount: 7, itemTotal: 1,
            itemCounts: { VIDEO: 1, AUDIO: 0, GIF: 0, IMAGE: 0 },
            collection: { id: COLLECTION, artist: { name: 'Kaze' }, deleted: false },
            moderation: { locked: false, reason: null, lockedAt: null, byId: null },
        });
    });

    it('summary tiles, and top rewards by live unlocks (a vanished one is skipped)', async () => {
        const { admin } = setup();
        expect(await admin.summary()).toEqual({
            rewards: { total: 3, on: 1, off: 1, removed: 1, lockedByHitbox: 1 },
            unlocks: { live: 40, thisMonth: 9, buyersWithRewards: 31 },
            topRewards: [{
                id: 'r1', name: 'Tour film', unlockedCount: 25,
                collection: { id: COLLECTION, name: 'Season One' }, artist: { id: 'a1', name: 'Kaze' },
            }],
        });
    });

    it('detail carries the files with preview links, the drops required, and where its audit trail is', async () => {
        const { admin } = setup();
        const detail = await admin.get('r1');
        expect(detail.items[0]).toMatchObject({ kind: 'VIDEO', url: 'https://s3/get/asset-1' });
        expect(detail.requiredDrops).toBe(2);
        expect(detail.auditTrail).toEqual({ resourceType: 'ContentBundle', resourceId: 'r1' });
        expect(await code(admin.get('nope'))).toBe(CONTENT_ERROR_CODES.REWARD_NOT_FOUND);
    });

    it('unlocks: who, when, LIVE or ENDED, and how often they opened it', async () => {
        const { admin } = setup();
        const page = await admin.unlocks('r1', { page: 1, limit: 20 });
        expect(page.items.map((u) => [u.buyer.handle, u.status, u.timesOpened])).toEqual([
            ['mia', 'LIVE', 4],
            [null, 'ENDED', 0],
        ]);
        expect(page.items[1]!.endedAt).toBe('2026-11-02T00:00:00.000Z');
    });
});

describe('moderation: switch off', () => {
    it('switches it off, locks it with the reason, audits and announces', async () => {
        const { admin, audits, events, current } = setup();
        const detail = await admin.moderate('r1', 'switch-off', 'Copyrighted footage', STAFF);
        expect(detail).toMatchObject({ status: 'OFF', moderation: { locked: true, reason: 'Copyrighted footage', byId: 'staff-1' } });
        expect(current()!.moderationLockedAt).toEqual(NOW);
        expect(audits[0]).toMatchObject({
            eventType: CONTENT_AUDIT_EVENTS.SWITCH_OFF,
            actor: { type: 'HITBOX_ADMIN', id: 'staff-1', roleSnapshot: 'HITBOX_SYSTEM_ADMIN' },
            beforeState: { isActive: true, moderationLockedAt: null },
            afterState: { isActive: false, moderationReason: 'Copyrighted footage' },
            metadata: { action: 'switch-off', reason: 'Copyrighted footage', collectionId: COLLECTION, artistId: 'a1' },
        });
        expect(events[0]).toMatchObject({ name: CONTENT_EVENTS.REWARD_MODERATED, payload: { action: 'switch-off' } });
    });

    it('the artist can still edit it, but not switch it back on', async () => {
        const { admin, artist } = setup();
        await admin.moderate('r1', 'switch-off', 'Copyrighted footage', STAFF);
        expect((await artist.save({ collectionId: COLLECTION, name: 'Renamed' })).reward.moderation.locked).toBe(true);
        const refused = await artist.save({ collectionId: COLLECTION, name: 'x', isActive: true }).catch((e: AppError) => e);
        expect(refused).toMatchObject({ code: CONTENT_ERROR_CODES.MODERATION_LOCKED, details: { reason: 'Copyrighted footage' } });
    });

    it('switching on lifts the lock and grants buyers who completed the set meanwhile', async () => {
        const { admin, artist, granted, audits } = setup(rewardRow(), ['buyer-9']);
        await admin.moderate('r1', 'switch-off', 'Review', STAFF);
        const back = await admin.moderate('r1', 'switch-on', undefined, STAFF);
        expect(back).toMatchObject({ status: 'ON', moderation: { locked: false, reason: null } });
        expect(granted).toEqual(['buyer-9']);
        expect(audits[1]).toMatchObject({ eventType: CONTENT_AUDIT_EVENTS.SWITCH_ON, metadata: { newlyUnlocked: 1 } });
        // Lifted: the artist is in control again.
        expect((await artist.save({ collectionId: COLLECTION, name: 'x', isActive: false })).reward.status).toBe('OFF');
    });

    it('refuses changes that change nothing, and undoing what the artist did', async () => {
        const off = setup(rewardRow({ isActive: false }));
        expect(await code(off.admin.moderate('r1', 'switch-off', 'x', STAFF))).toBe(CONTENT_ERROR_CODES.STATE_UNCHANGED);
        // Paused by the artist, not by HitBox: theirs to switch back on.
        expect(await code(off.admin.moderate('r1', 'switch-on', undefined, STAFF))).toBe(CONTENT_ERROR_CODES.NOT_MODERATED);
        const on = setup();
        expect(await code(on.admin.moderate('r1', 'switch-on', undefined, STAFF))).toBe(CONTENT_ERROR_CODES.STATE_UNCHANGED);
        expect(on.audits).toHaveLength(0);
    });
});

describe('moderation: remove', () => {
    it('removes and locks it; the artist cannot restore it; staff restore lifts the lock', async () => {
        const { admin, artist, audits } = setup();
        const removed = await admin.moderate('r1', 'remove', 'Explicit content', STAFF);
        expect(removed).toMatchObject({ status: 'REMOVED', moderation: { locked: true, reason: 'Explicit content' } });
        expect(await code(artist.save({ collectionId: COLLECTION, name: 'Tour film' }))).toBe(CONTENT_ERROR_CODES.MODERATION_LOCKED);

        const restored = await admin.moderate('r1', 'restore', 'Reviewed and cleared', STAFF);
        expect(restored).toMatchObject({ status: 'ON', moderation: { locked: false } });
        expect(audits.map((a) => a.eventType)).toEqual([CONTENT_AUDIT_EVENTS.REMOVE, CONTENT_AUDIT_EVENTS.RESTORE]);
    });

    it('switch on / off of a removed reward is refused — restore first', async () => {
        const { admin } = setup(rewardRow({ archivedAt: NOW, moderationLockedAt: NOW }));
        expect(await code(admin.moderate('r1', 'switch-on', undefined, STAFF))).toBe(CONTENT_ERROR_CODES.REWARD_ARCHIVED);
        expect(await code(admin.moderate('r1', 'switch-off', 'x', STAFF))).toBe(CONTENT_ERROR_CODES.REWARD_ARCHIVED);
        expect(await code(admin.moderate('r1', 'remove', 'x', STAFF))).toBe(CONTENT_ERROR_CODES.STATE_UNCHANGED);
    });

    it('a reward the artist removed is theirs to restore', async () => {
        const { admin } = setup(rewardRow({ archivedAt: NOW }));
        expect(await code(admin.moderate('r1', 'restore', undefined, STAFF))).toBe(CONTENT_ERROR_CODES.NOT_MODERATED);
    });
});

describe('request bodies', () => {
    it('switch-off and remove need a reason; switch-on and restore take an optional one', () => {
        expect(moderationTakedownSchema.safeParse({}).success).toBe(false);
        expect(moderationTakedownSchema.parse({ reason: ' Copyright ' })).toEqual({ reason: 'Copyright' });
        expect(moderationLiftSchema.parse({})).toEqual({});
        expect(moderationLiftSchema.safeParse({ reason: 'x', isActive: true }).success).toBe(false);
    });

    it('the list filters by the known statuses only', () => {
        expect(adminListRewardsQuerySchema.parse({ status: 'LOCKED' }).status).toBe('LOCKED');
        expect(adminListRewardsQuerySchema.safeParse({ status: 'PAUSED' }).success).toBe(false);
    });
});
