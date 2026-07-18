import type { MarketplaceCategory } from '../enums/marketplace-category.enum';

/** Card badge shown on the listing (derived from the product's status). */
export type ListingBadge = 'HOT' | 'NEW' | null;

/**
 * The listing card the Marketplace screen renders. Full product details
 * (description, provenance, all images) come from GET /products/:id when
 * the card is opened.
 */
export interface MarketplaceListingItem {
    id: string;
    name: string;
    imageUrl: string | null;
    artistName: string | null;
    priceInDollars: string;
    rewardPoints: number;
    badge: ListingBadge;
}

export type MarketplaceSort = 'newest' | 'price_asc' | 'price_desc' | 'popular';

export interface MarketplaceListingsQuery {
    category?: MarketplaceCategory;
    search?: string;
    sort: MarketplaceSort;
    /** Only products curated with a marketplace status (feed "featured" rail). */
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
