// Module factory
export { createMarketplaceModule } from './module';
export type { MarketplaceModule, MarketplaceModuleDeps } from './module';

// Constants
export {
    FEED_FEATURED_LIMIT,
    FEED_NEW_LISTINGS_LIMIT,
    MARKETPLACE_DEFAULT_PAGE_SIZE,
    MARKETPLACE_MAX_PAGE_SIZE,
    MARKETPLACE_MODULE,
} from './constants/marketplace.constant';

// Domain — the port the products module implements
export { MarketplaceCategory } from './domain/enums/marketplace-category.enum';
export type {
    IListingCatalog,
    MarketplaceListingItem,
    MarketplaceListingsQuery,
    MarketplaceListingsResult,
    MarketplacePrice,
    MarketplaceSort,
} from './domain/interfaces/listing-catalog.interface';

// DTOs
export { marketplaceFeedQuerySchema, marketplaceListingsQuerySchema } from './dto/marketplace.dto';
export type {
    MarketplaceFeedDto,
    MarketplaceFeedQueryDto,
    MarketplaceListingsQueryDto,
} from './dto/marketplace.dto';

// Service
export type { MarketplaceFeedQuery } from './service/marketplace.service';
