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
export type { ProductService } from './service/product.service';
export type { ProductWithRelations } from './repository/product.repository';
