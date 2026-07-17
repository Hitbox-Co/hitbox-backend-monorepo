// Module factory
export { createDiscoverModule } from './module';
export type { DiscoverModule, DiscoverModuleDeps } from './module';

// Constants
export {
    DISCOVER_DEFAULT_PAGE_SIZE,
    DISCOVER_MAX_PAGE_SIZE,
    DISCOVER_MODULE,
    FEED_FEATURED_LIMIT,
    FEED_SECTION_LIMIT,
} from './constants/discover.constant';

// Domain — the port the products module implements
export { DiscoverSection } from './domain/enums/discover-section.enum';
export type {
    DiscoverProductItem,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from './domain/interfaces/product-discovery.interface';

// DTOs
export { discoverProductsQuerySchema } from './dto/discover.dto';
export type { DiscoverFeedDto, DiscoverProductsQueryDto } from './dto/discover.dto';
