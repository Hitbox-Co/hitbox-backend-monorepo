import type { RewardKind } from '../domain/reward-kind';

/**
 * What the reward endpoints return. docs/content/collection-rewards.md.
 *
 * `url` is a signed, time-limited link to a private file (`expiresIn`
 * seconds). It is only ever issued to someone allowed to see the reward —
 * the artist who owns the collection, or a buyer who unlocked it — and must
 * not be cached past `expiresIn`.
 */
export interface RewardItemView {
    id: string;
    publicCode: string | null;
    assetId: string;
    kind: RewardKind | null;
    /** The artist's title, or the file name when none was given. */
    title: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    position: number;
    url: string | null;
    expiresIn: number | null;
}

export type ItemCounts = Record<RewardKind, number>;

/** The artist's own view of their collection's reward. */
export interface ArtistRewardView {
    id: string;
    publicCode: string | null;
    collectionId: string;
    name: string;
    description: string | null;
    /** ON: buyers unlock it and can open it. OFF: paused. REMOVED: deleted (restore with PUT). */
    status: 'ON' | 'OFF' | 'REMOVED';
    isActive: boolean;
    archivedAt: string | null;
    items: RewardItemView[];
    itemCounts: ItemCounts;
    /** Buyers who have it unlocked right now. */
    unlockedCount: number;
    /** Released drops a buyer must collect — every one of them. */
    requiredDrops: number;
    /** HitBox switched it off or removed it: while `locked`, you can't switch it on or restore it. */
    moderation: RewardModerationView;
    createdAt: string;
    updatedAt: string;
}

export interface RewardCollectionRef {
    id: string;
    name: string;
    slug: string;
    heroImageUrl: string | null;
    artist: { id: string; name: string; slug: string };
}

/** One unlocked reward in the buyer's list. */
export interface BuyerRewardSummary {
    id: string;
    publicCode: string | null;
    name: string;
    description: string | null;
    collection: RewardCollectionRef;
    unlockedAt: string;
    itemCounts: ItemCounts;
    itemTotal: number;
}

/** An unlocked reward, opened: the files with their signed links. */
export interface BuyerRewardDetail extends BuyerRewardSummary {
    items: RewardItemView[];
}

/** A collection's reward as a buyer sees it before (or after) unlocking. */
export interface RewardTeaser {
    reward: {
        id: string;
        name: string;
        description: string | null;
        itemCounts: ItemCounts;
        itemTotal: number;
    };
    collection: RewardCollectionRef;
    progress: {
        /** Released drops in the collection. */
        required: number;
        /** How many of them the buyer owns a claimed unit of. */
        collected: number;
        /** The ones still to collect. */
        missing: { dropId: string; publicCode: string | null; name: string }[];
        complete: boolean;
    };
    unlocked: boolean;
}

// ── Staff: monitoring and moderation (docs/content/admin-rewards-api.md) ──

/** Whether HitBox has switched the reward off or removed it, and why. */
export interface RewardModerationView {
    /** True while HitBox's switch-off / removal stands; the artist can't undo it. */
    locked: boolean;
    reason: string | null;
    lockedAt: string | null;
}

/** One reward in the staff list. */
export interface AdminRewardRow {
    id: string;
    publicCode: string | null;
    name: string;
    status: 'ON' | 'OFF' | 'REMOVED';
    isActive: boolean;
    archivedAt: string | null;
    collection: RewardCollectionRef & { deleted: boolean };
    itemCounts: ItemCounts;
    itemTotal: number;
    /** Buyers who can open it right now. */
    unlockedCount: number;
    moderation: RewardModerationView & { byId: string | null };
    createdAt: string;
    updatedAt: string;
}

/** One reward, in full, for staff: the files with preview links. */
export interface AdminRewardDetail extends AdminRewardRow {
    description: string | null;
    items: RewardItemView[];
    /** Released drops a buyer must collect. */
    requiredDrops: number;
    /** Query for its audit history: GET /admin/audit/events?resourceType=…&resourceId=… */
    auditTrail: { resourceType: 'ContentBundle'; resourceId: string };
}

export interface AdminRewardSummary {
    rewards: { total: number; on: number; off: number; removed: number; lockedByHitbox: number };
    unlocks: { live: number; thisMonth: number; buyersWithRewards: number };
    /** Rewards with the most live unlocks. */
    topRewards: {
        id: string;
        name: string;
        unlockedCount: number;
        collection: { id: string; name: string };
        artist: { id: string; name: string };
    }[];
}

/** A buyer who unlocked a reward. */
export interface AdminRewardUnlock {
    id: string;
    publicCode: string | null;
    buyer: { userId: string; handle: string | null; fullName: string | null };
    /** LIVE: can open it now. ENDED: lost it when a piece of the set was taken back. */
    status: 'LIVE' | 'ENDED';
    unlockedAt: string;
    endedAt: string | null;
    firstOpenedAt: string | null;
    lastOpenedAt: string | null;
    timesOpened: number;
}
