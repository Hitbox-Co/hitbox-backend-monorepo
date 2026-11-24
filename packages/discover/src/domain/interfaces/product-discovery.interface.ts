import type { DiscoverCategory } from '../enums/discover-category.enum';
import type { DiscoverSection } from '../enums/discover-section.enum';

/** The base price of the requested market, else of the default market. Null on the card when none is set. */
export interface DiscoverPrice {
    /** Decimal string ("480.00"); "0" when the drop is free. */
    amount: string;
    currency: string;
    isFree: boolean;
    /** The market this price belongs to. */
    marketId: string | null;
}

/**
 * One drop card — every field the Discover screen renders on the hero
 * carousel, "Trending now" and "Latest drops". Full details still come from
 * `GET /products/:id` when a card is opened.
 *
 * `rewardPoints` is `Drop.rewardPoints` — set by HitBox System Admin,
 * `0` when none were set.
 */
export interface DiscoverProductItem {
    id: string;
    name: string;
    /** `Drop.description` — the hero's tagline. */
    description: string | null;
    imageUrl: string | null;
    /** Free-form `Drop.rarity` as stored ("LEGENDARY", "RARE", …). */
    rarity: string | null;
    /** Free-form `Drop.category` as stored ("FIGURE", "TRADING_CARD", …). */
    category: string | null;
    /** The drop's artist, falling back to its collection's artist. */
    artist: { id: string; name: string; slug: string } | null;
    price: DiscoverPrice | null;
    /** Edition size — "Edition of 200". */
    totalSupply: number;
    /** SKUs minted so far — "042 / 100" is `mintedCount / totalSupply`. */
    mintedCount: number;
    rewardPoints: number;
    /** Whether the viewer has wishlisted it; null when the request is anonymous. */
    isWishlisted: boolean | null;
}

/** One "Meet the creators" entry. */
export interface DiscoverCreatorItem {
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
    /** The banner image shown for the leading creator. */
    coverUrl: string | null;
    /** Publicly visible drops — "12 drops". */
    dropCount: number;
}

export interface DiscoverProductsQuery {
    section?: DiscoverSection;
    category?: DiscoverCategory;
    search?: string;
    page: number;
    limit: number;
    /** The signed-in account, for `isWishlisted`. Absent for guests. */
    viewerId?: string;
    /** Optional `?marketId=`: show prices of this market (default market when absent, unknown or not priced there). */
    marketId?: string;
}

export interface DiscoverProductsResult {
    items: DiscoverProductItem[];
    total: number;
}

export interface DiscoverCreatorsQuery {
    page: number;
    limit: number;
}

export interface DiscoverCreatorsResult {
    items: DiscoverCreatorItem[];
    total: number;
}

/**
 * Port implemented by the products module and injected at bootstrap
 * (same pattern as auth's IAccountLookup ← users). When discover becomes
 * its own service, this becomes an HTTP/RPC client against products —
 * nothing in this module changes.
 */
export interface IProductDiscovery {
    findProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult>;
    /** Public artists with at least one public drop, most drops first. */
    findCreators(query: DiscoverCreatorsQuery): Promise<DiscoverCreatorsResult>;
}
