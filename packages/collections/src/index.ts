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

// Port implemented by the artist module (consumer defines, provider implements)
export type {
    ArtistCollectionCapacity,
    IArtistCollectionStats,
} from './domain/interfaces/artist-collection-stats.interface';

// Service type (for other modules that receive it via DI)
export type { CollectionService } from './service/collection.service';
