import type { Logger } from 'pino';
import type { MarketplaceCategory } from '../domain/enums/marketplace-category.enum';
import {
    FEED_FEATURED_LIMIT,
    FEED_NEW_LISTINGS_LIMIT,
} from '../constants/marketplace.constant';
import type {
    IListingCatalog,
    MarketplaceListingsQuery,
    MarketplaceSort,
    MarketplaceListingsResult,
} from '../domain/interfaces/listing-catalog.interface';
import type { MarketplaceFeedDto } from '../dto/marketplace.dto';

export interface MarketplaceFeedQuery {
    category?: MarketplaceCategory;
    viewerId?: string;
}

interface MarketplaceServiceDeps {
    catalog: IListingCatalog;
    logger: Logger;
}

export class MarketplaceService {
    constructor(private readonly deps: MarketplaceServiceDeps) { }

    /**
     * The whole Marketplace screen in one call:
     *  - featured    → curated products (any marketplace status), most sold first
     *  - newListings → newest active products
     * Live auctions join this feed once the P2P trading feature lands.
     */
    /**
     * The whole screen in one call. The category chip narrows every section.
     *
     * "Featured" is a drop inside a declared release window (see the
     * products adapter). When fewer than FEED_FEATURED_LIMIT qualify, the
     * section is topped up with the most popular drops — same category, no
     * duplicates — so the grid is never empty while anything is on sale.
     */
    async getFeed(query: MarketplaceFeedQuery = {}): Promise<MarketplaceFeedDto> {
        const list = (sort: MarketplaceSort, limit: number, featuredOnly = false) =>
            this.deps.catalog
                .findListings({ ...query, featuredOnly, sort, page: 1, limit })
                .then((result) => result.items);

        const [featured, newListings] = await Promise.all([
            list('popular', FEED_FEATURED_LIMIT, true),
            list('newest', FEED_NEW_LISTINGS_LIMIT),
        ]);

        if (featured.length >= FEED_FEATURED_LIMIT) return { featured, newListings };

        const shown = new Set(featured.map((item) => item.id));
        const popular = await list('popular', FEED_FEATURED_LIMIT * 2);
        const filled = [...featured, ...popular.filter((item) => !shown.has(item.id))]
            .slice(0, FEED_FEATURED_LIMIT);
        return { featured: filled, newListings };
    }

    async listListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult> {
        return this.deps.catalog.findListings(query);
    }
}
