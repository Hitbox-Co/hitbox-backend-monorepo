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
    attachProductImagesSchema,
    createProductSchema,
    listProductsQuerySchema,
    productImageInputSchema,
    productPriceInputSchema,
    replaceProductImagesSchema,
    setProductPricesSchema,
    updateProductImageSchema,
    updateProductPriceSchema,
    updateProductSchema,
} from './dto/product.dto';
export type {
    AttachProductImagesDto,
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    ProductImageInput,
    ProductImageResponse,
    ProductPriceInput,
    ProductPriceResponse,
    ReplaceProductImagesDto,
    SetProductPricesDto,
    UpdateProductDto,
    UpdateProductImageDto,
    UpdateProductPriceDto,
} from './dto/product.dto';

// Service type (for other modules that receive it via DI)
export type { ProductService, ProductResponse } from './service/product.service';
export type { ProductWithRelations } from './repository/product.repository';
export { PRODUCT_SORTS, PUBLIC_PRODUCT_WHERE } from './repository/product.repository';

// Port: bootstrap injects an adapter that turns a MediaAsset storageRef into
// a renderable URL. Products owns no object-storage knowledge itself.
export type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';

// Port: bootstrap injects @hitbox/media, which owns MediaAsset, so the gallery
// can validate an asset exists and is an image before joining to it.
export type {
    IMediaAssets,
    MediaAssetRef,
} from './domain/interfaces/media-assets.interface';

// Port: bootstrap injects @hitbox/markets, which owns Market, so a price can
// be validated and can inherit its market's settlement currency.
export type {
    IMarketLookup,
    MarketRef,
} from './domain/interfaces/market-lookup.interface';

// Port: bootstrap injects @hitbox/skus so a drop and its serialized edition
// are created in one transaction. Products never writes the Sku table itself.
export type {
    ISkuMinting,
    SkuMintOutcome,
    SkuMintSpec,
} from './domain/interfaces/sku-minting.interface';
