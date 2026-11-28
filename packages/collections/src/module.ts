import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { COLLECTIONS_MODULE } from './constants/collections.constant';
import { CollectionController } from './controller/collection.controller';
import { CollectionProgressController } from './controller/collection-progress.controller';
import type { IDropCardCatalog } from './domain/interfaces/drop-card-catalog.interface';
import type { IArtistCollectionStats } from './domain/interfaces/artist-collection-stats.interface';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
import { BuyerCollectionRepository } from './repository/buyer-collection.repository';
import { CollectionProgressRepository } from './repository/collection-progress.repository';
import { CollectionProgressService } from './service/collection-progress.service';
import { CollectionService } from './service/collection.service';

export interface CollectionsModuleDeps {
    prisma: PrismaClient;
    /** artist module's adapter — supplies ArtistCollection capacity for progress. */
    artistStats: IArtistCollectionStats;
    /**
     * Resolves a `MediaAsset.storageRef` to a renderable URL. Optional: omit
     * it and shelf items come back with `imageUrl: null` rather than failing,
     * which is correct on a deploy with no bucket configured.
     */
    mediaUrls?: IMediaUrlResolver | undefined;
    /** products' card adapter — the drop cards on a collection's set screen. */
    dropCards: IDropCardCatalog;
}

export interface CollectionsModule {
    service: CollectionService;
    /** "How much of this collection do I own?" — the buyer's set progress. */
    progress: CollectionProgressService;
    /** requireAuth comes from the auth module at bootstrap. */
    /** `optionalAuth` lets `/user/:userId` recognise the owner looking at their own shelf. */
    createRouter(requireAuth: RequestHandler, optionalAuth?: RequestHandler): Router;
}

export function createCollectionsModule(deps: CollectionsModuleDeps): CollectionsModule {
    const logger = createModuleLogger(COLLECTIONS_MODULE);

    const collections = new BuyerCollectionRepository(deps.prisma);
    const service = new CollectionService({
        collections,
        artistStats: deps.artistStats,
        logger,
        mediaUrls: deps.mediaUrls,
    });

    const progress = new CollectionProgressService({
        progress: new CollectionProgressRepository(deps.prisma),
        dropCards: deps.dropCards,
        logger,
    });

    return {
        service,
        progress,
        createRouter(requireAuth, optionalAuth) {
            const controller = new CollectionController(service);
            const viewer: RequestHandler = optionalAuth ?? ((_req, _res, next) => next());
            const router = Router();

            // /me/stats before /me/:skuId is a non-issue (distinct verb/path),
            // but keeping the static route first is the safe convention.
            router.get('/me/stats', requireAuth, controller.stats);
            router.get('/me', requireAuth, controller.listMine);
            router.patch('/me/:skuId', requireAuth, controller.setVisibility);
            router.get('/user/:userId', viewer, controller.listPublicByUser);

            // Set progress: public collection contents; a token adds "mine".
            const progressController = new CollectionProgressController(progress);
            router.get('/artist/:artistId', viewer, progressController.listForArtist);
            router.get('/:collectionId/progress', viewer, progressController.detail);

            return router;
        },
    };
}
