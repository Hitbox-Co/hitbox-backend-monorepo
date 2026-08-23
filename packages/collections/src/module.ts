import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import type { RequirePermission } from '@hitbox/authz';
import { createModuleLogger } from '@hitbox/shared';
import { COLLECTIONS_MODULE } from './constants/collections.constant';
import { CollectionController } from './controller/collection.controller';
import type { IArtistCollectionStats } from './domain/interfaces/artist-collection-stats.interface';
import { BuyerCollectionRepository } from './repository/buyer-collection.repository';
import { CollectionService } from './service/collection.service';

export interface CollectionsModuleDeps {
    prisma: PrismaClient;
    /** artist module's adapter — supplies ArtistCollection capacity for progress. */
    artistStats: IArtistCollectionStats;
}

export interface CollectionsModule {
    service: CollectionService;
    /** requireAuth from @hitbox/auth, requirePermission from @hitbox/authz. */
    createRouter(requireAuth: RequestHandler, requirePermission: RequirePermission): Router;
}

export function createCollectionsModule(deps: CollectionsModuleDeps): CollectionsModule {
    const logger = createModuleLogger(COLLECTIONS_MODULE);

    const collections = new BuyerCollectionRepository(deps.prisma);
    const service = new CollectionService({
        collections,
        artistStats: deps.artistStats,
        logger,
    });

    return {
        service,
        createRouter(requireAuth, requirePermission) {
            const controller = new CollectionController(service);
            const router = Router();

            // /me/stats before /me/:productId is a non-issue (distinct verb/path),
            // but keeping the static route first is the safe convention.
            //
            // These are all "/me" routes: the controller derives the subject
            // from req.auth.accountId, so the row can only ever be the
            // caller's own. A capability check is therefore sufficient — there
            // is no id in the request that could point at somebody else.
            router.get('/me/stats', requireAuth, requirePermission('collection', 'read'), controller.stats);
            router.get('/me', requireAuth, requirePermission('collection', 'read'), controller.listMine);
            router.patch(
                '/me/:productId',
                requireAuth,
                requirePermission('collection', 'update'),
                controller.setVisibility,
            );
            router.get('/user/:userId', controller.listPublicByUser);

            return router;
        },
    };
}
