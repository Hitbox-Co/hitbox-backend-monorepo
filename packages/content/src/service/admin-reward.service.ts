import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    ADMIN_TOP_REWARDS,
    CONTENT_AUDIT_EVENTS,
    CONTENT_ERROR_CODES,
    CONTENT_EVENTS,
} from '../constants/content.constant';
import type { IContentAuditRecorder } from '../domain/content-audit.port';
import type { IRewardMedia } from '../domain/reward-media.port';
import type {
    AdminRewardDetail,
    AdminRewardRow,
    AdminRewardSummary,
    AdminRewardUnlock,
} from '../dto/reward.views';
import type { AdminRewardStatus, ContentRepository, RewardRow } from '../repository/content.repository';
import { collectionRef, isOpen, itemCounts, itemViews, moderationOf } from './reward-mapping';
import type { RewardUnlockService } from './reward-unlock.service';

/** Who is acting — from the permission check that let them in. */
export interface ContentStaffActor {
    userId: string;
    roleName?: string | null;
}

export type ModerationAction = 'switch-off' | 'switch-on' | 'remove' | 'restore';

interface AdminRewardServiceDeps {
    content: ContentRepository;
    unlocks: RewardUnlockService;
    audit: IContentAuditRecorder;
    media?: IRewardMedia | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    now?: () => Date;
}

const AUDIT_EVENT: Record<ModerationAction, string> = {
    'switch-off': CONTENT_AUDIT_EVENTS.SWITCH_OFF,
    'switch-on': CONTENT_AUDIT_EVENTS.SWITCH_ON,
    remove: CONTENT_AUDIT_EVENTS.REMOVE,
    restore: CONTENT_AUDIT_EVENTS.RESTORE,
};

/**
 * HitBox staff over every collection reward: monitoring (list, summary,
 * detail with previews, who unlocked it) and moderation.
 *
 * **Moderation is a lock, not a toggle.** Switching a reward off or removing
 * it sets `moderationLockedAt`; while it stands, the artist can still edit the
 * reward's name and files but cannot switch it back on or restore it (409
 * CONTENT_REWARD_MODERATION_LOCKED). Only staff lift it — `switch-on` or
 * `restore` — and staff only undo what staff did: a reward the artist paused
 * or removed themselves stays the artist's call (409 NOT_MODERATED).
 *
 * Buyers' unlocks are never deleted. A switched-off or removed reward can't be
 * opened; lifting the lock opens it again for everyone who had it, and grants
 * it to anyone who completed the set in the meantime.
 */
export class AdminRewardService {
    constructor(private readonly deps: AdminRewardServiceDeps) { }

    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    // ── Monitoring ──────────────────────────────────────────────────────────

    async list(query: {
        artistId?: string | undefined;
        collectionId?: string | undefined;
        status?: AdminRewardStatus | undefined;
        q?: string | undefined;
        page: number;
        limit: number;
    }): Promise<{ page: number; limit: number; total: number; items: AdminRewardRow[] }> {
        const { total, items } = await this.deps.content.adminList({
            artistId: query.artistId,
            collectionId: query.collectionId,
            status: query.status,
            q: query.q,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        const counts = await this.deps.content.liveGrantCounts(items.map((r) => r.id), this.now());
        return { page: query.page, limit: query.limit, total, items: items.map((r) => row(r, counts.get(r.id) ?? 0)) };
    }

    async summary(): Promise<AdminRewardSummary> {
        const now = this.now();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [counts, top] = await Promise.all([
            this.deps.content.adminCounts(now, monthStart),
            this.deps.content.topByUnlocks(ADMIN_TOP_REWARDS, now),
        ]);
        const rewards = new Map((await this.deps.content.findRewards(top.map((t) => t.bundleId))).map((r) => [r.id, r]));
        return {
            rewards: {
                total: counts.total,
                on: counts.on,
                off: counts.off,
                removed: counts.removed,
                lockedByHitbox: counts.locked,
            },
            unlocks: {
                live: counts.liveUnlocks,
                thisMonth: counts.unlocksThisMonth,
                buyersWithRewards: counts.buyersWithRewards,
            },
            topRewards: top.flatMap((t) => {
                const reward = rewards.get(t.bundleId);
                if (!reward?.collection) return [];
                return [{
                    id: reward.id,
                    name: reward.name,
                    unlockedCount: t.unlocks,
                    collection: { id: reward.collection.id, name: reward.collection.name },
                    artist: { id: reward.collection.artist.id, name: reward.collection.artist.name },
                }];
            }),
        };
    }

    async get(rewardId: string): Promise<AdminRewardDetail> {
        return this.detail(await this.requireReward(rewardId));
    }

    async unlocks(
        rewardId: string,
        query: { status?: 'LIVE' | 'ENDED' | undefined; page: number; limit: number },
    ): Promise<{ page: number; limit: number; total: number; items: AdminRewardUnlock[] }> {
        await this.requireReward(rewardId);
        const now = this.now();
        const { total, items } = await this.deps.content.listUnlocks({
            bundleId: rewardId,
            status: query.status,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            now,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((u) => {
                const live = u.accessExpiresAt === null || u.accessExpiresAt > now;
                return {
                    id: u.id,
                    publicCode: u.publicCode,
                    buyer: { userId: u.user.id, handle: u.user.handle, fullName: u.user.fullName },
                    status: live ? 'LIVE' : 'ENDED',
                    unlockedAt: u.grantedAt.toISOString(),
                    endedAt: live ? null : (u.accessExpiresAt?.toISOString() ?? null),
                    firstOpenedAt: u.acknowledgedAt?.toISOString() ?? null,
                    lastOpenedAt: u.lastAccessedAt?.toISOString() ?? null,
                    timesOpened: u.accessCount,
                };
            }),
        };
    }

    // ── Moderation ──────────────────────────────────────────────────────────

    async moderate(
        rewardId: string,
        action: ModerationAction,
        reason: string | undefined,
        actor: ContentStaffActor,
    ): Promise<AdminRewardDetail> {
        const before = await this.requireReward(rewardId);
        const now = this.now();
        const lock = { moderationLockedAt: now, moderationReason: reason ?? null, moderatedById: actor.userId };
        const unlock = { moderationLockedAt: null, moderationReason: null, moderatedById: actor.userId };
        let data: Parameters<ContentRepository['updateReward']>[1];

        switch (action) {
            case 'switch-off':
                if (before.archivedAt) throw conflict('This reward is removed. Restore it to change whether it is on.', CONTENT_ERROR_CODES.REWARD_ARCHIVED);
                if (!before.isActive) throw conflict('This reward is already off.', CONTENT_ERROR_CODES.STATE_UNCHANGED);
                data = { isActive: false, ...lock };
                break;
            case 'switch-on':
                if (before.archivedAt) throw conflict('This reward is removed. Restore it first.', CONTENT_ERROR_CODES.REWARD_ARCHIVED);
                if (before.isActive) throw conflict('This reward is already on.', CONTENT_ERROR_CODES.STATE_UNCHANGED);
                if (before.moderationLockedAt == null) throw notModerated('paused');
                data = { isActive: true, ...unlock };
                break;
            case 'remove':
                if (before.archivedAt) throw conflict('This reward is already removed.', CONTENT_ERROR_CODES.STATE_UNCHANGED);
                data = { archivedAt: now, ...lock };
                break;
            case 'restore':
                if (!before.archivedAt) throw conflict('This reward is not removed.', CONTENT_ERROR_CODES.STATE_UNCHANGED);
                if (before.moderationLockedAt == null) throw notModerated('removed');
                // Restoring lifts the lock entirely — if HitBox had also switched
                // it off, it comes back off but the artist may switch it on.
                data = { archivedAt: null, ...unlock };
                break;
        }

        const after = await this.deps.content.updateReward(rewardId, data, now);
        // Back on: everyone who completed the set while it was down gets it.
        const newlyUnlocked = isOpen(after) && !isOpen(before) ? await this.deps.unlocks.grantToCompleters(after) : 0;

        await this.deps.audit.record({
            eventType: AUDIT_EVENT[action],
            actor: { type: 'HITBOX_ADMIN', id: actor.userId, roleSnapshot: actor.roleName ?? null },
            result: 'SUCCESS',
            organizationId: before.collection?.organizationId ?? null,
            resource: { type: 'ContentBundle', id: rewardId },
            beforeState: snapshot(before),
            afterState: snapshot(after),
            correlationId: randomUUID(),
            metadata: {
                action,
                collectionId: before.collectionId,
                artistId: before.collection?.artist.id ?? null,
                ...(reason ? { reason } : {}),
                ...(newlyUnlocked > 0 ? { newlyUnlocked } : {}),
            },
        });
        await this.deps.eventBus?.publish(CONTENT_EVENTS.REWARD_MODERATED, {
            rewardId,
            collectionId: before.collectionId,
            artistId: before.collection?.artist.id ?? null,
            action,
            reason: reason ?? null,
            actorId: actor.userId,
        });
        this.deps.logger.info({ rewardId, action, actorId: actor.userId }, 'collection reward moderated');
        return this.detail(after);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireReward(rewardId: string): Promise<RewardRow> {
        const row = await this.deps.content.findReward(rewardId);
        if (!row) throw AppError.notFound('Reward not found.', CONTENT_ERROR_CODES.REWARD_NOT_FOUND);
        return row;
    }

    private async detail(reward: RewardRow): Promise<AdminRewardDetail> {
        const now = this.now();
        const [counts, drops, items] = await Promise.all([
            this.deps.content.liveGrantCounts([reward.id], now),
            reward.collectionId ? this.deps.content.releasedDrops(reward.collectionId) : Promise.resolve([]),
            // Staff review the files themselves — moderation needs to see them.
            itemViews(reward.contentBundleItems, this.deps.media, true),
        ]);
        return {
            ...row(reward, counts.get(reward.id) ?? 0),
            description: reward.description,
            items,
            requiredDrops: drops.length,
            auditTrail: { resourceType: 'ContentBundle', resourceId: reward.id },
        };
    }
}

function row(reward: RewardRow, unlockedCount: number): AdminRewardRow {
    return {
        id: reward.id,
        publicCode: reward.publicCode,
        name: reward.name,
        status: reward.archivedAt ? 'REMOVED' : reward.isActive ? 'ON' : 'OFF',
        isActive: reward.isActive,
        archivedAt: reward.archivedAt?.toISOString() ?? null,
        collection: { ...collectionRef(reward), deleted: reward.collection?.archivedAt != null },
        itemCounts: itemCounts(reward.contentBundleItems),
        itemTotal: reward.contentBundleItems.length,
        unlockedCount,
        moderation: { ...moderationOf(reward), byId: reward.moderatedById ?? null },
        createdAt: reward.createdAt.toISOString(),
        updatedAt: reward.updatedAt.toISOString(),
    };
}

function snapshot(reward: RewardRow) {
    return {
        name: reward.name,
        isActive: reward.isActive,
        archivedAt: reward.archivedAt?.toISOString() ?? null,
        moderationLockedAt: reward.moderationLockedAt?.toISOString() ?? null,
        moderationReason: reward.moderationReason ?? null,
        itemCount: reward.contentBundleItems.length,
    };
}

function conflict(message: string, code: string): AppError {
    return AppError.conflict(message, code);
}

function notModerated(what: 'paused' | 'removed'): AppError {
    return AppError.conflict(
        `The artist ${what} this reward themselves, so it is theirs to bring back. ` +
        'HitBox can only undo a switch-off or removal HitBox made.',
        CONTENT_ERROR_CODES.NOT_MODERATED,
    );
}
