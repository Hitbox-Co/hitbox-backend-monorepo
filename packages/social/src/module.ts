import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { SOCIAL_MODULE } from './constants/social.constant';
import { FollowController } from './controller/follow.controller';
import { WishlistController } from './controller/wishlist.controller';
import type { IWishlistCatalog } from './domain/interfaces/wishlist-catalog.interface';
import { FollowRepository } from './repository/follow.repository';
import { WishlistRepository } from './repository/wishlist.repository';
import { FollowService } from './service/follow.service';
import { WishlistService } from './service/wishlist.service';

export interface SocialModuleDeps {
    prisma: PrismaClient;
    /** Implemented by the products module (`productsModule.cards`), injected at bootstrap. */
    catalog: IWishlistCatalog;
}

export interface SocialModule {
    wishlist: WishlistService;
    /** Follow counts and state — bootstrap feeds them into users' profile stats. */
    follows: FollowService;
    /** Mounted at /api/v1/wishlist. Every route needs a signed-in buyer. */
    createWishlistRouter(requireAuth: RequestHandler): Router;
    /**
     * Mounted at /api/v1/follows. Follow/unfollow need a signed-in buyer;
     * the lists are public and use `optionalAuth` only to fill `isFollowedByYou`.
     */
    createFollowsRouter(requireAuth: RequestHandler, optionalAuth: RequestHandler): Router;
}

export function createSocialModule(deps: SocialModuleDeps): SocialModule {
    const logger = createModuleLogger(SOCIAL_MODULE);
    const wishlist = new WishlistService({
        wishlist: new WishlistRepository(deps.prisma),
        catalog: deps.catalog,
        logger,
    });

    const follows = new FollowService({ follows: new FollowRepository(deps.prisma), logger });

    return {
        wishlist,
        follows,
        createFollowsRouter(requireAuth, optionalAuth) {
            const controller = new FollowController(follows);
            const router = Router();
            router.get('/users/:userId/followers', optionalAuth, controller.followers);
            router.get('/users/:userId/following', optionalAuth, controller.following);
            router.post('/users/:userId', requireAuth, controller.followUser);
            router.delete('/users/:userId', requireAuth, controller.unfollowUser);
            router.post('/artists/:artistId', requireAuth, controller.followArtist);
            router.delete('/artists/:artistId', requireAuth, controller.unfollowArtist);
            return router;
        },
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
