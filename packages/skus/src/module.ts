import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    SKU_READ_CAPABILITY,
    SKU_TAG_CAPABILITY,
    SKU_WRITE_CAPABILITY,
    SKUS_MODULE,
} from './constants/skus.constant';
import { SkuController } from './controller/sku.controller';
import type { SkuPrincipalResolver } from './controller/sku.controller';
import { SkuRepository } from './repository/sku.repository';
import { SkuService } from './service/sku.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface SkusPermissionGuard {
    requirePermission(
        capability: string,
        options?: {
            context?: (req: Request) => unknown | Promise<unknown>;
            globalOnly?: boolean;
        },
    ): RequestHandler;
}

export interface SkusModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: SkusPermissionGuard;
    resolvePrincipal: SkuPrincipalResolver;
}

export interface SkusModule {
    /**
     * The minting port. Injected into the products module so `POST
     * /admin/products` can create a drop and its edition in one transaction.
     */
    minting: SkuService;
    /** Mounted at /api/v1/admin/products/:productId/skus. */
    createProductRouter(requireAuth: RequestHandler): Router;
    /** Mounted at /api/v1/admin/skus. */
    createRouter(requireAuth: RequestHandler): Router;
}

export function createSkusModule(deps: SkusModuleDeps): SkusModule {
    const logger = createModuleLogger(SKUS_MODULE);
    const skus = new SkuRepository(deps.prisma);
    const service = new SkuService({ skus, eventBus: deps.eventBus, logger });
    const controller = new SkuController(service, deps.resolvePrincipal);

    /**
     * Access context for the product-scoped routes.
     *
     * Without this an organization-scoped grant cannot match at all: the
     * engine refuses an ORGANIZATION-breadth grant that arrives with no
     * organization to compare against, so a Brand Admin would be refused on
     * their own drop. One indexed primary-key read buys correct behaviour for
     * every org-scoped role.
     *
     * Returning `{}` for an unknown product is deliberate — the guard then
     * denies an org-scoped caller and the service returns 404 for a global
     * one, so a missing id never reveals itself through a different status
     * code than an out-of-scope one.
     */
    const productContext = async (req: Request) => {
        const productId = req.params.productId;
        if (!productId) return {};
        const organizationId = await skus.findProductOrganization(productId);
        return organizationId === undefined ? {} : { organizationId };
    };

    /** The same, resolved through the unit to the drop that owns it. */
    const skuContext = async (req: Request) => {
        const skuId = req.params.skuId;
        if (!skuId) return {};
        const organizationId = await skus.findSkuOrganization(skuId);
        return organizationId === undefined ? {} : { organizationId };
    };

    return {
        minting: service,

        createProductRouter(requireAuth) {
            // mergeParams: the router is mounted under a path carrying
            // :productId, and without it `req.params.productId` is undefined.
            const router = Router({ mergeParams: true });
            router.use(requireAuth);

            router.get(
                '/',
                deps.guard.requirePermission(SKU_READ_CAPABILITY, { context: productContext }),
                controller.listForProduct,
            );
            router.get(
                '/summary',
                deps.guard.requirePermission(SKU_READ_CAPABILITY, { context: productContext }),
                controller.summary,
            );

            // Minting is NOT globalOnly: a Brand Admin holding
            // `collectible-instance:manage:organization` mints the edition for
            // a drop they own, and the context above confines them to it.
            router.post(
                '/',
                deps.guard.requirePermission(SKU_WRITE_CAPABILITY, { context: productContext }),
                controller.mint,
            );

            // Applying a tag manifest to an already-minted edition. Gated on
            // tag custody, NOT on minting: a Drop Manager mints the edition,
            // and whoever holds `nfc-tag-claim:manage` binds the tags to it.
            router.post(
                '/tags',
                deps.guard.requirePermission(SKU_TAG_CAPABILITY, { context: productContext }),
                controller.bulkBindTags,
            );

            return router;
        },

        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            // The cross-drop list carries no product in its path, so there is
            // no organization to check against and only a grant with global
            // breadth matches. Org-scoped callers reach their units through
            // /admin/products/:productId/skus instead.
            router.get(
                '/',
                deps.guard.requirePermission(SKU_READ_CAPABILITY),
                controller.list,
            );
            router.get(
                '/code/:skuCode',
                deps.guard.requirePermission(SKU_READ_CAPABILITY),
                controller.getByCode,
            );
            router.get(
                '/:skuId',
                deps.guard.requirePermission(SKU_READ_CAPABILITY, { context: skuContext }),
                controller.getById,
            );
            router.patch(
                '/:skuId/tag',
                deps.guard.requirePermission(SKU_TAG_CAPABILITY, { context: skuContext }),
                controller.bindTag,
            );

            return router;
        },
    };
}
