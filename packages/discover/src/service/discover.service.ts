import type { Logger } from 'pino';
import {
    FEED_FEATURED_LIMIT,
    FEED_SECTION_LIMIT,
} from '../constants/discover.constant';
import { DiscoverSection } from '../domain/enums/discover-section.enum';
import type {
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from '../domain/interfaces/product-discovery.interface';
import type { DiscoverFeedDto } from '../dto/discover.dto';

interface DiscoverServiceDeps {
    catalog: IProductDiscovery;
    logger: Logger;
}

export class DiscoverService {
    constructor(private readonly deps: DiscoverServiceDeps) { }

    /**
     * The whole Discover screen in one call. Sections are queried in
     * parallel; "featured" reuses trending until a dedicated featured
     * flag exists on products.
     */
    async getFeed(): Promise<DiscoverFeedDto> {
        const first = (section: DiscoverSection, limit: number) =>
            this.deps.catalog
                .findProducts({ section, page: 1, limit })
                .then((result) => result.items);

        const [featured, trending, newReleases, topCreators] = await Promise.all([
            first(DiscoverSection.TRENDING, FEED_FEATURED_LIMIT),
            first(DiscoverSection.TRENDING, FEED_SECTION_LIMIT),
            first(DiscoverSection.NEW_RELEASES, FEED_SECTION_LIMIT),
            first(DiscoverSection.TOP_CREATORS, FEED_SECTION_LIMIT),
        ]);

        return { featured, trending, newReleases, topCreators };
    }

    /** Paginated list behind "See All" / the search bar. */
    async listProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult> {
        return this.deps.catalog.findProducts(query);
    }
}
