import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { IProductDiscovery } from '@hitbox/discover';
import type { IListingCatalog } from '@hitbox/marketplace';
import { PRODUCTS_MODULE } from './constants/products.constant';
import { ProductCache } from './cache/product-cache';
import { ProductController } from './controller/product.controller';
import { MarketplaceListingAdapter } from './domain/marketplace-listing.adapter';
import { ProductDiscoveryAdapter } from './domain/product-discovery.adapter';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
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
}

export interface ProductsModule {
    service: ProductService;
    /** Injected into createDiscoverModule — discover's port, products' adapter. */
    discovery: IProductDiscovery;
    /** Injected into createMarketplaceModule — marketplace's port, products' adapter. */
    listings: IListingCatalog;
    /** requireAuth comes from the auth module at bootstrap. */
    createRouter(requireAuth: RequestHandler): Router;
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
    });

    return {
        service,
        discovery: new ProductDiscoveryAdapter(products, deps.mediaUrls),
        listings: new MarketplaceListingAdapter(products, deps.mediaUrls),
        createRouter(requireAuth) {
            const controller = new ProductController(service);
            const router = Router();

            // Public catalog. The NFC tag routes that used to live here moved
            // out with the schema restructure — tags belong to Sku now, and
            // provenance to the claims module's /verify and /ledger.
            router.get('/', controller.list);
            router.get('/code/:groupCode', controller.getByCode);
            router.get('/:id', controller.getById);

            // Catalog management — requireAuth for now; role-based
            // permissions (ADMIN) plug in here once roles expand.
            router.post('/', requireAuth, controller.create);
            router.patch('/:id', requireAuth, controller.update);
            router.delete('/:id', requireAuth, controller.archive);

            return router;
        },
    };
}
