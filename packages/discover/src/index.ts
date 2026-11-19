// Module factory
export { createDiscoverModule } from './module';
export type { DiscoverModule, DiscoverModuleDeps } from './module';

// Constants
export {
    DISCOVER_DEFAULT_PAGE_SIZE,
    DISCOVER_MAX_PAGE_SIZE,
    DISCOVER_MODULE,
    FEED_CREATORS_LIMIT,
    FEED_FEATURED_LIMIT,
    FEED_SECTION_LIMIT,
} from './constants/discover.constant';

// Domain — the port the products module implements
export { DiscoverCategory } from './domain/enums/discover-category.enum';
export { DiscoverSection } from './domain/enums/discover-section.enum';
export type {
    DiscoverCreatorItem,
    DiscoverCreatorsQuery,
    DiscoverCreatorsResult,
    DiscoverPrice,
    DiscoverProductItem,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from './domain/interfaces/product-discovery.interface';

// Service
export type { DiscoverFeedQuery } from './service/discover.service';

// DTOs
export {
    discoverCreatorsQuerySchema,
    discoverFeedQuerySchema,
    discoverProductsQuerySchema,
} from './dto/discover.dto';
export type {
    DiscoverCreatorsQueryDto,
    DiscoverFeedDto,
    DiscoverFeedQueryDto,
    DiscoverProductsQueryDto,
} from './dto/discover.dto';
