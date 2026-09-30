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
import type { IMediaAssets } from './domain/interfaces/media-assets.interface';
import type { IMarketLookup } from './domain/interfaces/market-lookup.interface';
import type { ISkuMinting } from './domain/interfaces/sku-minting.interface';
import type { IProductAudit } from './domain/interfaces/product-audit.interface';
import type { IReleaseGate } from './domain/interfaces/release-gate.interface';
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
     * Validates media assets before they are joined into a product gallery.
     * Provided by @hitbox/media, which owns the `MediaAsset` table.
     *
     * Optional: omit it and image attachment is refused with a clear error
     * rather than writing joins nobody checked.
     */
    mediaAssets?: IMediaAssets | undefined;
    /**
     * Resolves the markets a price refers to. Provided by @hitbox/markets,
     * which owns the `Market` table and its settlement currency.
     *
     * Optional: omit it and pricing is refused with a clear error. Since at
     * least one price is required to create a drop, a deployment without this
     * cannot create products at all — which is the honest outcome.
     */
    markets?: IMarketLookup | undefined;
    /**
     * Answers "has this drop cleared review?" before it is published.
     * Provided by @hitbox/releases, which owns `ReleaseApproval`.
     *
     * Optional: omit it and publishing is REFUSED rather than allowed. A
     * deployment that cannot verify an approval must not take drops live on
     * the assumption that one exists.
     */
    releaseGate?: IReleaseGate | undefined;
    /**
     * The compliance trail for publication. Optional so tests need not wire
     * the audit module; a server must pass the real recorder.
     */
    audit?: IProductAudit | undefined;
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
        options?: {
            /** May be async: finding the drop's owner is a query. */
            context?: (
                req: Request,
            ) =>
                | { organizationId?: string | null; ownerId?: string | null }
                | Promise<{ organizationId?: string | null; ownerId?: string | null }>;
            globalOnly?: boolean;
        },
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
        mediaAssets: deps.mediaAssets,
        markets: deps.markets,
        releaseGate: deps.releaseGate,
        audit: deps.audit,
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

            // ── Reads name the drop whose organization decides ────────────
            //
            // `drop:read` is held by an artist and a Brand Admin only through
            // `drop:manage:organization` — MANAGE is the one sanctioned
            // implication, and the catalog has no `drop:read:organization` at
            // all. An organization-scoped grant is rejected outright when the
            // request names no organization, so guarding these with the bare
            // capability made the drop detail screen platform-staff-only: an
            // artist could be asked to approve a drop and then get a 403
            // opening it.
            //
            // The writes below stay `globalOnly` — catalog administration is
            // platform-wide by design, and that is unchanged.
            const dropOrganization = async (req: Request) => ({
                organizationId: req.params.id
                    ? await products.organizationIdOf(req.params.id)
                    : null,
            });

            // The detail screen: catalog record + performance + SKU units.
            router.get(
                '/:id',
                guard.requirePermission(PRODUCT_READ_CAPABILITY, { context: dropOrganization }),
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

            /**
             * Taking a drop live.
             *
             * Its own route because publishing is a transition with
             * preconditions — the owner's approval above all — and `PATCH`
             * carries none. `status` was removed from the update schema in the
             * same change: a gate is worthless while an ungated door sits next
             * to it.
             */
            router.post(
                '/:id/publish',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.publish,
            );

            // Market pricing. Reading takes the same capability as the detail
            // screen; writing is catalog administration like any other edit.
            router.get(
                '/:id/prices',
                guard.requirePermission(PRODUCT_READ_CAPABILITY, { context: dropOrganization }),
                controller.listPrices,
            );
            router.put(
                '/:id/prices',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.setPrices,
            );
            router.patch(
                '/:id/prices/:priceId',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.updatePrice,
            );
            router.delete(
                '/:id/prices/:priceId',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.removePrice,
            );

            // Gallery. Reading takes the same capability as the detail screen;
            // writing is catalog administration like any other product edit.
            router.get(
                '/:id/images',
                guard.requirePermission(PRODUCT_READ_CAPABILITY, { context: dropOrganization }),
                controller.listImages,
            );
            router.post(
                '/:id/images',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.attachImages,
            );
            router.put(
                '/:id/images',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.replaceImages,
            );
            router.patch(
                '/:id/images/:imageId',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.updateImage,
            );
            router.delete(
                '/:id/images/:imageId',
                guard.requirePermission(PRODUCT_WRITE_CAPABILITY, { globalOnly: true }),
                controller.removeImage,
            );

            return router;
        },
    };
}
