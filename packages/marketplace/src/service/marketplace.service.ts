import type { Logger } from 'pino';
import {
    FEED_FEATURED_LIMIT,
    FEED_NEW_LISTINGS_LIMIT,
} from '../constants/marketplace.constant';
import type {
    IListingCatalog,
    MarketplaceListingsQuery,
    MarketplaceListingsResult,
} from '../domain/interfaces/listing-catalog.interface';
import type { MarketplaceFeedDto } from '../dto/marketplace.dto';

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
    async getFeed(): Promise<MarketplaceFeedDto> {
        const [featured, newListings] = await Promise.all([
            this.deps.catalog
                .findListings({ featuredOnly: true, sort: 'popular', page: 1, limit: FEED_FEATURED_LIMIT })
                .then((result) => result.items),
            this.deps.catalog
                .findListings({ sort: 'newest', page: 1, limit: FEED_NEW_LISTINGS_LIMIT })
                .then((result) => result.items),
        ]);

        return { featured, newListings };
    }

    /** Paginated listings behind the category tabs, search bar and "See All". */
    async listListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult> {
        return this.deps.catalog.findListings(query);
    }
}
