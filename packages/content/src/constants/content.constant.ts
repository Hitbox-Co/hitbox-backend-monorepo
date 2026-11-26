/**
 * Collection rewards — exclusive content a buyer unlocks by collecting every
 * released drop of an artist collection. docs/content/collection-rewards.md.
 */

export const CONTENT_MODULE = 'content' as const;

/**
 * The buyer side: viewing rewards you unlocked. `own` scope, checked against
 * the caller's own id — BUYER_COLLECTOR holds `content-unlock:read:own`.
 */
export const REWARD_READ_CAPABILITY = 'content-unlock:read' as const;

/**
 * HitBox staff: monitoring and moderating every collection reward.
 * `content-unlock:manage` at **global** scope only (`globalOnly`): held by
 * HITBOX_SYSTEM_ADMIN and HITBOX_CONTENT_MANAGER. A Brand Admin's or an
 * artist's `:organization` grant does not pass. docs/content/admin-rewards-api.md.
 */
export const REWARD_ADMIN_CAPABILITY = 'content-unlock:manage' as const;

export const CONTENT_ERROR_CODES = {
    /** No reward on this collection (or it is switched off / removed). */
    REWARD_NOT_FOUND: 'CONTENT_REWARD_NOT_FOUND',
    /** The reward was removed — restore it (PUT) before changing its files. */
    REWARD_ARCHIVED: 'CONTENT_REWARD_ARCHIVED',
    /** Not unlocked: collect every drop of the collection first. */
    REWARD_LOCKED: 'CONTENT_REWARD_LOCKED',
    /** Not a video, music track, GIF or image. */
    FILE_TYPE: 'CONTENT_REWARD_FILE_TYPE',
    /** The file is missing, not uploaded yet, not this collection's, removed or infected. */
    FILE_INVALID: 'CONTENT_REWARD_FILE_INVALID',
    /** The file is already in this reward. */
    FILE_DUPLICATE: 'CONTENT_REWARD_FILE_DUPLICATE',
    ITEM_NOT_FOUND: 'CONTENT_REWARD_ITEM_NOT_FOUND',
    TOO_MANY_ITEMS: 'CONTENT_REWARD_TOO_MANY_ITEMS',
    /** The reorder list is not exactly the reward's items. */
    ORDER_MISMATCH: 'CONTENT_REWARD_ORDER_MISMATCH',
    /** No storage bucket on this server, so files can't be uploaded or viewed. */
    MEDIA_UNAVAILABLE: 'CONTENT_REWARD_MEDIA_UNAVAILABLE',
    /** HitBox switched this reward off or removed it; only HitBox can lift that. */
    MODERATION_LOCKED: 'CONTENT_REWARD_MODERATION_LOCKED',
    /** Staff can only undo what staff did: the artist paused / removed it themselves. */
    NOT_MODERATED: 'CONTENT_REWARD_NOT_MODERATED',
    /** The action would change nothing. */
    STATE_UNCHANGED: 'CONTENT_REWARD_STATE_UNCHANGED',
} as const;

/** Staff moderation, audited — registered in @hitbox/audit's catalog. */
export const CONTENT_AUDIT_EVENTS = {
    SWITCH_OFF: 'content.reward.switch-off',
    SWITCH_ON: 'content.reward.switch-on',
    REMOVE: 'content.reward.remove',
    RESTORE: 'content.reward.restore',
    /** HitBox put specific unclaimed SKUs on a drop's exclusive tier. */
    EXCLUSIVE_UNITS_ADD: 'content.drop-exclusive.units-add',
    /** HitBox took specific unclaimed SKUs off a drop's exclusive tier. */
    EXCLUSIVE_UNITS_REMOVE: 'content.drop-exclusive.units-remove',
} as const;

export const CONTENT_EVENTS = {
    /** A buyer unlocked a reward (first time, or again after losing it). */
    REWARD_UNLOCKED: 'content.reward.unlocked',
    /** A buyer lost a reward: a piece of the set was taken back (refund, dispute). */
    REWARD_ACCESS_LOST: 'content.reward.access-lost',
    /** HitBox staff switched a reward off/on, removed or restored it. */
    REWARD_MODERATED: 'content.reward.moderated',
} as const;

export const ADMIN_REWARDS_DEFAULT_LIMIT = 20;
export const ADMIN_REWARDS_MAX_LIMIT = 100;
export const ADMIN_TOP_REWARDS = 5;

/** Events from other modules this one reacts to. Strings, not imports. */
export const SUBSCRIBED_EVENTS = {
    PRODUCT_CLAIMED: 'claims.product.claimed',
    CLAIM_REVOKED: 'claims.claim.revoked',
} as const;

/**
 * A drop counts towards completing a collection once it has been released —
 * published, on sale, or ended. Drafts and drops in review don't: a buyer
 * cannot own one, and a set must be completable.
 */
export const RELEASED_DROP_STATUSES = ['PUBLISHED', 'ACTIVE', 'ENDED'] as const;

/** Files in one reward. A guard against runaway clients; raise freely. */
export const MAX_REWARD_ITEMS = 20;

export const REWARD_NAME_MAX = 120;
export const REWARD_DESCRIPTION_MAX = 2000;
export const REWARD_ITEM_TITLE_MAX = 200;

/** Size caps per kind, in bytes. Media's own cap (500 MB) is the outer bound. */
export const MAX_BYTES_BY_KIND = {
    VIDEO: 500 * 1024 * 1024,
    AUDIO: 100 * 1024 * 1024,
    GIF: 50 * 1024 * 1024,
    IMAGE: 25 * 1024 * 1024,
} as const;

// ── Drop content — docs/content/drop-content.md ─────────────────────────────

/**
 * A drop's content comes in two tiers:
 *   - REGULAR: one per drop, for the owner of any unit of it;
 *   - EXCLUSIVE: only for the owners of the specific units it names, by
 *     serial number ("#001 of 100"). A drop can have several.
 * Exclusive content comes on top of the regular content, not instead of it.
 */
export type DropContentTier = 'REGULAR' | 'EXCLUSIVE';

export const DROP_CONTENT_ACCESS = {
    REGULAR: 'OWNER_ONLY',
    EXCLUSIVE: 'SKU_EXCLUSIVE',
} as const;

/** Exclusive tiers one drop may have (removed ones included). Raise freely. */
export const MAX_EXCLUSIVE_TIERS_PER_DROP = 10;
/** Units one exclusive tier may name. */
export const MAX_SERIALS_PER_TIER = 1000;

export const DROP_CONTENT_ERROR_CODES = {
    /** No such content on this drop. */
    NOT_FOUND: 'DROP_CONTENT_NOT_FOUND',
    /** The drop already has its regular content — edit that one. */
    REGULAR_EXISTS: 'DROP_CONTENT_REGULAR_EXISTS',
    /** The drop already has the maximum number of exclusive tiers. */
    TOO_MANY_TIERS: 'DROP_CONTENT_TOO_MANY_TIERS',
    /** A serial number is outside 1…totalSupply, or serials were sent for regular content / left out for exclusive. */
    SERIALS_INVALID: 'DROP_CONTENT_SERIALS_INVALID',
    /** Removed content is read-only: restore it first. */
    ARCHIVED: 'DROP_CONTENT_ARCHIVED',
    /** Restore was asked for content that isn't removed. */
    NOT_ARCHIVED: 'DROP_CONTENT_NOT_ARCHIVED',
    /** The buyer does not own a unit that opens it. */
    LOCKED: 'DROP_CONTENT_LOCKED',
    /** The unit isn't the caller's, isn't claimed, or doesn't exist. */
    UNIT_NOT_FOUND: 'DROP_CONTENT_UNIT_NOT_FOUND',
    /** The drop doesn't exist or isn't released. */
    DROP_NOT_FOUND: 'DROP_CONTENT_DROP_NOT_FOUND',
    /** Admin selection: the content is regular, not an exclusive tier. */
    NOT_EXCLUSIVE: 'DROP_CONTENT_NOT_EXCLUSIVE',
    /** Admin selection: a SKU isn't a unit of this drop. */
    UNIT_NOT_IN_DROP: 'DROP_CONTENT_UNIT_NOT_IN_DROP',
    /**
     * Admin selection: a SKU is already claimed (or owned), so whether it
     * opens exclusive content is settled — it can no longer be added or taken off.
     */
    UNIT_CLAIMED: 'DROP_CONTENT_UNIT_CLAIMED',
} as const;

export const DROP_CONTENT_EVENTS = {
    /** A buyer opened a drop's content with one of their units for the first time. */
    OPENED: 'content.drop-content.opened',
} as const;
