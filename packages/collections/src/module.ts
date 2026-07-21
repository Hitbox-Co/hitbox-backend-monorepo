import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
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
    /** requireAuth comes from the auth module at bootstrap. */
    createRouter(requireAuth: RequestHandler): Router;
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
        createRouter(requireAuth) {
            const controller = new CollectionController(service);
            const router = Router();

            // /me/stats before /me/:productId is a non-issue (distinct verb/path),
            // but keeping the static route first is the safe convention.
            router.get('/me/stats', requireAuth, controller.stats);
            router.get('/me', requireAuth, controller.listMine);
            router.patch('/me/:productId', requireAuth, controller.setVisibility);
            router.get('/user/:userId', controller.listPublicByUser);

            return router;
        },
    };
}
