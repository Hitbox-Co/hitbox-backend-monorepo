import type { MarketplaceCategory } from '../enums/marketplace-category.enum';

/**
 * The listing card the Marketplace screen renders. Full product details
 * (description, provenance, all images) come from GET /products/:id when
 * the card is opened.
 *
 * `rewardPoints` and `badge` were removed when the catalog schema was
 * restructured: `Product.rewardPoints` and `Product.marketplaceStatus` no
 * longer exist, and nothing replaced them. They were dropped rather than
 * stubbed with `0`/`null`, so the card advertises only fields the database
 * can actually answer for.
 */
export interface MarketplaceListingItem {
    id: string;
    name: string;
    imageUrl: string | null;
    artistName: string | null;
    /** Decimal string in `currency`, or null when no price is set for the default market. */
    priceInDollars: string | null;
    /** ISO code of the market the price is quoted in; null when there is no price. */
    currency: string | null;
}

/**
 * `price_asc`/`price_desc` were removed with the catalog restructure: price
 * moved from a `Product` column to the market-scoped `ProductPrice` table,
 * and a query cannot be ordered by a field on a to-many relation. Restoring
 * them needs a denormalized base-price column on `Product` or a raw-SQL join.
 *
 * `popular` was backed by `Product.unitsSold`, which no longer exists — it is
 * now minted SKU count, a proxy for edition size rather than for sales.
 */
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
