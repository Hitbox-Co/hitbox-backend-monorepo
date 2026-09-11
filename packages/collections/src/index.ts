// Module factory
export { createCollectionsModule } from './module';
export type { CollectionsModule, CollectionsModuleDeps } from './module';

// Constants
export {
    COLLECTIONS_DEFAULT_PAGE_SIZE,
    COLLECTIONS_ERROR_CODES,
    COLLECTIONS_MAX_PAGE_SIZE,
    COLLECTIONS_MODULE,
} from './constants/collections.constant';

// DTOs
export { listCollectionQuerySchema, updateVisibilitySchema } from './dto/collection.dto';
export type {
    CollectionItemDto,
    CollectionProgressDto,
    CollectionStatsDto,
    ListCollectionQueryDto,
    UpdateVisibilityDto,
} from './dto/collection.dto';

// Ports this module consumes (consumer defines, provider implements,
// bootstrap connects). artist supplies collection capacity; media supplies
// the URL for a product image's storage key.
export type {
    ArtistCollectionCapacity,
    IArtistCollectionStats,
} from './domain/interfaces/artist-collection-stats.interface';
export type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';

// Service type (for other modules that receive it via DI)
export type { CollectionService } from './service/collection.service';
