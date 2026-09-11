// Module factory
export { createProductsModule } from './module';
export type { ProductsModule, ProductsModuleDeps } from './module';

// Constants
export {
    PRODUCT_EVENTS,
    PRODUCTS_ERROR_CODES,
    PRODUCTS_MODULE,
} from './constants/products.constant';

// DTOs
export {
    createProductSchema,
    listProductsQuerySchema,
    updateProductSchema,
} from './dto/product.dto';
export type {
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    UpdateProductDto,
} from './dto/product.dto';

// Service type (for other modules that receive it via DI)
export type { ProductService, ProductResponse } from './service/product.service';
export type { ProductWithRelations } from './repository/product.repository';
export { PRODUCT_SORTS, PUBLIC_PRODUCT_WHERE } from './repository/product.repository';

// Port: bootstrap injects an adapter that turns a MediaAsset storageRef into
// a renderable URL. Products owns no object-storage knowledge itself.
export type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
