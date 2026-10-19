import type { DiscoverSection } from '../enums/discover-section.enum';

/**
 * The lightweight card the Discover screen renders — image + title only.
 *
 * `rewardPoints` was removed when the catalog schema was restructured:
 * `Product.rewardPoints` no longer exists and nothing replaced it. Dropped
 * rather than stubbed with `0`, so the card advertises only fields the
 * database can actually answer for.
 */
export interface DiscoverProductItem {
    id: string;
    name: string;
    imageUrl: string | null;
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
