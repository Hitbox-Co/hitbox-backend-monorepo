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
import { ProductRepository } from './repository/product.repository';
import { ProductService } from './service/product.service';

export interface ProductsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
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
    const service = new ProductService({ products, eventBus: deps.eventBus, logger });

    return {
        service,
        discovery: new ProductDiscoveryAdapter(products),
        listings: new MarketplaceListingAdapter(products),
        createRouter(requireAuth) {
            const controller = new ProductController(service);
            const router = Router();

            // Public catalog
            router.get('/', controller.list);
            router.get('/code/:productCode', controller.getByCode);
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
