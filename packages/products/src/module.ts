import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { RequirePermission } from '@hitbox/authz';
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
    /**
     * requireAuth comes from @hitbox/auth and requirePermission from
     * @hitbox/authz — both injected at bootstrap, so this module never builds
     * its own authentication or authorization stack.
     */
    createRouter(requireAuth: RequestHandler, requirePermission: RequirePermission): Router;
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
        createRouter(requireAuth, requirePermission) {
            const controller = new ProductController(service);
            const router = Router();

            // Public catalog — the storefront is readable without a session.
            router.get('/', controller.list);
            router.get('/code/:productCode', controller.getByCode);
            router.get('/tag/:tagId/history', controller.history);
            router.get('/tag/:tagId', controller.getByTag);
            router.get('/:id', controller.getById);

            // ── Catalog management ────────────────────────────────────────
            // Capability check only: there is no existing row to test yet, and
            // the service stamps ownership/tenancy from the request context.
            router.post('/', requireAuth, requirePermission('product', 'create'), controller.create);

            // Capability check AND resource policy check. `resource` loads the
            // row's owner + tenant so the guard can tell "may update products"
            // apart from "may update THIS product": an artist with
            // product:update:own passes only for their own row, a product
            // manager with product:update:organization only inside their tenant.
            router.patch(
                '/:id',
                requireAuth,
                requirePermission('product', 'update', {
                    resource: (req) => service.refFor(req.params.id as string),
                }),
                controller.update,
            );
            router.delete(
                '/:id',
                requireAuth,
                requirePermission('product', 'delete', {
                    resource: (req) => service.refFor(req.params.id as string),
                }),
                controller.archive,
            );

            return router;
        },
    };
}
