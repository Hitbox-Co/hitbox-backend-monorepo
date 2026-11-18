import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { SOCIAL_MODULE } from './constants/social.constant';
import { WishlistController } from './controller/wishlist.controller';
import type { IWishlistCatalog } from './domain/interfaces/wishlist-catalog.interface';
import { WishlistRepository } from './repository/wishlist.repository';
import { WishlistService } from './service/wishlist.service';

export interface SocialModuleDeps {
    prisma: PrismaClient;
    /** Implemented by the products module (`productsModule.cards`), injected at bootstrap. */
    catalog: IWishlistCatalog;
}

export interface SocialModule {
    wishlist: WishlistService;
    /** Mounted at /api/v1/wishlist. Every route needs a signed-in buyer. */
    createWishlistRouter(requireAuth: RequestHandler): Router;
}

export function createSocialModule(deps: SocialModuleDeps): SocialModule {
    const logger = createModuleLogger(SOCIAL_MODULE);
    const wishlist = new WishlistService({
        wishlist: new WishlistRepository(deps.prisma),
        catalog: deps.catalog,
        logger,
    });

    return {
        wishlist,
        createWishlistRouter(requireAuth) {
            const controller = new WishlistController(wishlist);
            const router = Router();
            // Only the caller's own rows are ever read or written, so a
            // signed-in account is the whole check — no capability needed.
            router.use(requireAuth);
            router.get('/', controller.list);
            router.post('/', controller.add);
            router.delete('/products/:productId', controller.removeByProduct);
            router.patch('/:itemId', controller.update);
            router.delete('/:itemId', controller.remove);
            return router;
        },
    };
}
