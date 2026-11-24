import type { Logger } from 'pino';
import {
    FEED_CREATORS_LIMIT,
    FEED_FEATURED_LIMIT,
    FEED_SECTION_LIMIT,
} from '../constants/discover.constant';
import type { DiscoverCategory } from '../domain/enums/discover-category.enum';
import { DiscoverSection } from '../domain/enums/discover-section.enum';
import type {
    DiscoverCreatorsQuery,
    DiscoverCreatorsResult,
    DiscoverProductItem,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from '../domain/interfaces/product-discovery.interface';
import type { DiscoverFeedDto } from '../dto/discover.dto';

interface DiscoverServiceDeps {
    catalog: IProductDiscovery;
    logger: Logger;
}

export interface DiscoverFeedQuery {
    category?: DiscoverCategory;
    viewerId?: string;
    marketId?: string;
}

export class DiscoverService {
    constructor(private readonly deps: DiscoverServiceDeps) { }

    /**
     * The whole Discover screen in one call, every section queried in
     * parallel. The category chip narrows the drop sections only — creators
     * are the same whichever chip is selected.
     */
    async getFeed(query: DiscoverFeedQuery = {}): Promise<DiscoverFeedDto> {
        const first = (section: DiscoverSection, limit: number) =>
            this.deps.catalog
                .findProducts({ ...query, section, page: 1, limit })
                .then((result) => result.items);

        const [featured, trending, creators, newReleases] = await Promise.all([
            first(DiscoverSection.FEATURED, FEED_FEATURED_LIMIT),
            first(DiscoverSection.TRENDING, FEED_SECTION_LIMIT),
            this.deps.catalog
                .findCreators({ page: 1, limit: FEED_CREATORS_LIMIT })
                .then((result) => result.items),
            first(DiscoverSection.NEW_RELEASES, FEED_SECTION_LIMIT),
        ]);

        return { featured: this.fillFeatured(featured, trending), trending, creators, newReleases };
    }

    /**
     * The hero must never be empty. When fewer than FEED_FEATURED_LIMIT drops
     * sit in the top rarity tiers, top it up from trending (already fetched,
     * same category) in trending order, skipping drops already shown. It can
     * only be empty when there is no public drop at all in that category.
     */
    private fillFeatured(
        featured: DiscoverProductItem[],
        trending: DiscoverProductItem[],
    ): DiscoverProductItem[] {
        if (featured.length >= FEED_FEATURED_LIMIT) return featured;
        const shown = new Set(featured.map((item) => item.id));
        const fill = trending.filter((item) => !shown.has(item.id));
        return [...featured, ...fill].slice(0, FEED_FEATURED_LIMIT);
    }

    /** Paginated list behind "View all" / the search bar. */
    async listProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult> {
        return this.deps.catalog.findProducts(query);
    }

    /** Paginated list behind the creators' "Explore". */
    async listCreators(query: DiscoverCreatorsQuery): Promise<DiscoverCreatorsResult> {
        return this.deps.catalog.findCreators(query);
    }
}
