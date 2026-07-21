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
    ListCollectionQueryDto,
    UpdateVisibilityDto,
} from './dto/collection.dto';

// Service type (for other modules that receive it via DI)
export type { CollectionService } from './service/collection.service';
