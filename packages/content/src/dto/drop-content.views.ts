import type { DropContentTier } from '../constants/content.constant';
import type { ItemCounts, RewardItemView, RewardModerationView } from './reward.views';

/**
 * What the drop content endpoints return. docs/content/drop-content.md.
 *
 * Same file rules and signed links as collection rewards (`RewardItemView`):
 * a `url` is only ever issued to the artist who owns the drop, or to a buyer
 * who owns a unit that opens the content.
 */

export interface DropContentDropRef {
    id: string;
    publicCode: string | null;
    name: string;
    /** Units in the edition — serial numbers run 1…totalSupply. */
    totalSupply: number;
}

/** One content tier of a drop, as the artist who owns the drop sees it. */
export interface ArtistDropContentView {
    id: string;
    publicCode: string | null;
    dropId: string;
    /** REGULAR: every owner of the drop. EXCLUSIVE: only owners of `serialNumbers`. */
    tier: DropContentTier;
    name: string;
    description: string | null;
    /** ON: owners can open it. OFF: paused. REMOVED: deleted (restore it). */
    status: 'ON' | 'OFF' | 'REMOVED';
    isActive: boolean;
    archivedAt: string | null;
    /** EXCLUSIVE: the units that open it, ascending. REGULAR: always []. */
    serialNumbers: number[];
    items: RewardItemView[];
    itemCounts: ItemCounts;
    /** Buyers who own a unit that opens it, right now. */
    holders: number;
    /** Buyers who have opened it at least once. */
    openedBy: number;
    moderation: RewardModerationView;
    createdAt: string;
    updatedAt: string;
}

/** GET …/drops/:dropId/content — everything on the drop, removed tiers included. */
export interface ArtistDropContentOverview {
    drop: DropContentDropRef;
    regular: ArtistDropContentView | null;
    exclusive: ArtistDropContentView[];
    limits: { maxExclusiveTiers: number; maxSerialsPerTier: number; maxItemsPerTier: number };
}

export interface BuyerUnitRef {
    skuId: string;
    publicCode: string | null;
    serialNumber: number;
}

/** One content tier as a buyer sees it — opened when one of their units opens it. */
export interface BuyerDropContentTier {
    id: string;
    publicCode: string | null;
    tier: DropContentTier;
    name: string;
    description: string | null;
    itemCounts: ItemCounts;
    itemTotal: number;
    /** EXCLUSIVE: the units that open it ("#001"), so the app can say which. REGULAR: []. */
    eligibleSerials: number[];
    /** One of the buyer's units opens it. When false, `items` is []. */
    unlocked: boolean;
    /** The buyer's units that open it. */
    unlockedBy: BuyerUnitRef[];
    /** The files with signed links — only when `unlocked`. */
    items: RewardItemView[];
}

/** GET /rewards/drops/:dropId and GET /rewards/units/:skuId */
export interface BuyerDropContent {
    drop: DropContentDropRef;
    /** The units this answer was worked out for: all of yours (drop), or the one asked for (unit). */
    myUnits: BuyerUnitRef[];
    /** Switched-on content only: regular first, then exclusive. Locked tiers are teasers. */
    content: BuyerDropContentTier[];
}
