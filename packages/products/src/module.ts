import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { IProductDiscovery } from '@hitbox/discover';
import type { IListingCatalog } from '@hitbox/marketplace';
import {
    PRODUCT_READ_CAPABILITY,
    PRODUCT_WRITE_CAPABILITY,
    PRODUCTS_MODULE,
} from './constants/products.constant';
import { ProductCache } from './cache/product-cache';
import { ProductController } from './controller/product.controller';
import { MarketplaceListingAdapter } from './domain/marketplace-listing.adapter';
import { ProductDiscoveryAdapter } from './domain/product-discovery.adapter';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
import type { ISkuMinting } from './domain/interfaces/sku-minting.interface';
import { ProductRepository } from './repository/product.repository';
import { ProductService } from './service/product.service';

export interface ProductsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /**
     * Resolves a `MediaAsset.storageRef` to a renderable URL.
     *
     * Optional: omit it and every `imageUrl` comes back null rather than the
     * catalog failing — which is the right behaviour on a deploy with no
     * bucket configured, where the media routes are not mounted either.
     */
    mediaUrls?: IMediaUrlResolver | undefined;
    /**
     * Mints the serialized units of a drop, so `POST /admin/products` can
     * create a catalog entry and its edition in one transaction.
     *
     * Optional: omit it and a create carrying a `skus` block is refused with a
     * clear error, rather than quietly producing a drop with no units.
     */
    skuMinting?: ISkuMinting | undefined;
    /**
     * Required only to build the admin router. The public catalog router is
     * read-only and needs no authorization.
     */
    guard?: ProductsPermissionGuard | undefined;
}

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface ProductsPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface ProductsModule {
    service: ProductService;
    /** Injected into createDiscoverModule — discover's port, products' adapter. */
    discovery: IProductDiscovery;
    /** Injected into createMarketplaceModule — marketplace's port, products' adapter. */
    listings: IListingCatalog;
    /** Public, read-only catalog. Mounted at /api/v1/products. */
    createRouter(requireAuth: RequestHandler): Router;
    /** Catalog administration. Mounted at /api/v1/admin/products. */
    createAdminRouter(requireAuth: RequestHandler): Router;
}

export function createProductsModule(deps: ProductsModuleDeps): ProductsModule {
    const logger = createModuleLogger(PRODUCTS_MODULE);

    const cache = new ProductCache();
    const products = new ProductRepository(deps.prisma, cache);
    const service = new ProductService({
        products,
        eventBus: deps.eventBus,
        logger,
        mediaUrls: deps.mediaUrls,
        skuMinting: deps.skuMinting,
    });

    return {
        service,
        discovery: new ProductDiscoveryAdapter(products, deps.mediaUrls),
        listings: new MarketplaceListingAdapter(products, deps.mediaUrls),
        createRouter(_requireAuth) {
            const controller = new ProductController(service);
            const router = Router();

            // Public catalog, read-only. The NFC tag routes that used to live
            // here moved out with the schema restructure — tags belong to Sku
            // now, and provenance to the claims module's /verify and /ledger.
            router.get('/', controller.list);
            router.get('/code/:groupCode', controller.getByCode);
            router.get('/:id', controller.getById);

            // Catalog *writes* used to sit here behind `requireAuth` alone,
            // which let any signed-in buyer create or archive a drop. They
            // moved to createAdminRouter() below, behind a capability.
            return router;
        },

        createAdminRouter(requireAuth) {
            const controller = new ProductController(service);
            const router = Router();
            router.use(requireAuth);

            if (!deps.guard) {
                throw new Error(
                    'createProductsModule({ guard }) is required to build the admin router.',
                );
            }
            const { guard } = deps;

            // The detail screen: catalog record + performance + SKU units.
            router.get(
                '/:id',
                guard.requirePermission(PRODUCT_READ_CAPABILITY),
                controller.getDetail,
            );

            // Catalog administration is platform-wide only. A Brand Admin
            // holding `drop:manage:organization` manages their own drops
            // through their own surface; the admin catalog edits every
            // organization's, so it takes a global grant.
            router.post(
                '/',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.create,
            );
            router.patch(
                '/:id',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.update,
            );
            router.delete(
                '/:id',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.archive,
            );

            return router;
        },
    };
}
