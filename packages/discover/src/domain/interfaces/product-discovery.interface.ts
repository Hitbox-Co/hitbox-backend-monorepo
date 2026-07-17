import type { DiscoverSection } from '../enums/discover-section.enum';

/** The lightweight card the Discover screen renders — image + title only. */
export interface DiscoverProductItem {
    id: string;
    name: string;
    imageUrl: string | null;
    rewardPoints: number;
}

export interface DiscoverProductsQuery {
    section?: DiscoverSection;
    search?: string;
    page: number;
    limit: number;
}

export interface DiscoverProductsResult {
    items: DiscoverProductItem[];
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
}
