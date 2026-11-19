import type { MarketplaceCategory } from '../enums/marketplace-category.enum';

/**
 * The listing card the Marketplace screen renders. Full product details
 * (description, provenance, all images) come from GET /products/:id when
 * the card is opened.
 *
 * `badge` was removed when the catalog schema was restructured:
 * `Product.marketplaceStatus` no longer exists, and nothing replaced it.
 * `rewardPoints` is back as `Drop.rewardPoints` — set by HitBox System
 * Admin, `0` when none were set.
 */
/** The base price of the default market. Null on the card when none is set. */
export interface MarketplacePrice {
    /** Decimal string with two places ("480.00"); "0" when the drop is free. */
    amount: string;
    currency: string;
    isFree: boolean;
}

/**
 * One listing card — every field the Marketplace grid renders. The same
 * shape as a Discover card (the products module builds both from one
 * projection), declared here so this module depends on neither discover nor
 * the database. Full details come from `GET /products/:id` on tap.
 */
export interface MarketplaceListingItem {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    /** Free-form `Drop.rarity` as stored ("UNCOMMON", "RARE", …). */
    rarity: string | null;
    /** Free-form `Drop.category` as stored ("FIGURE", "TRADING_CARD", …). */
    category: string | null;
    /** The drop's artist, falling back to its collection's artist. */
    artist: { id: string; name: string; slug: string } | null;
    price: MarketplacePrice | null;
    /** Edition size — "Edition of 150". */
    totalSupply: number;
    /** SKUs minted so far — "009 / 60" is `mintedCount / totalSupply`. */
    mintedCount: number;
    /** `Drop.rewardPoints` — set by HitBox System Admin; 0 when none. */
    rewardPoints: number;
    /** Whether the viewer has wishlisted it; null when the request is anonymous. */
    isWishlisted: boolean | null;
}

export type MarketplaceSort = 'newest' | 'popular';

export interface MarketplaceListingsQuery {
    category?: MarketplaceCategory;
    search?: string;
    sort: MarketplaceSort;
    /**
     * Only products inside their release window (`ACTIVE`), excluding ones
     * merely `PUBLISHED`. Replaces the old "has a marketplaceStatus" curation
     * flag, which had no schema backing after the restructure.
     */
    featuredOnly?: boolean;
    page: number;
    limit: number;
    /** The signed-in account, for `isWishlisted`. Absent for guests. */
    viewerId?: string;
}

export interface MarketplaceListingsResult {
    items: MarketplaceListingItem[];
    total: number;
}

/**
 * Port implemented by the products module and injected at bootstrap
 * (same pattern as discover's IProductDiscovery). When marketplace becomes
 * its own service, this becomes an HTTP/RPC client against products.
 */
export interface IListingCatalog {
    findListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult>;
}
