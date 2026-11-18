import { Router } from 'express';
import type { RequestHandler } from 'express';
import { createModuleLogger } from '@hitbox/shared';
import { MARKETPLACE_MODULE } from './constants/marketplace.constant';
import { MarketplaceController } from './controller/marketplace.controller';
import type { IListingCatalog } from './domain/interfaces/listing-catalog.interface';
import { MarketplaceService } from './service/marketplace.service';

export interface MarketplaceModuleDeps {
    /** Implemented by the products module, injected at bootstrap. */
    catalog: IListingCatalog;
    /**
     * Auth's optional-auth middleware. Attaches `req.auth` when a valid
     * session is sent, so cards can carry `isWishlisted`; never rejects.
     * Omitted → every request is served as a guest.
     */
    optionalAuth?: RequestHandler;
}

export interface MarketplaceModule {
    service: MarketplaceService;
    /** Browse routes are public — buying/trading routes will require auth. */
    router: Router;
}

export function createMarketplaceModule(deps: MarketplaceModuleDeps): MarketplaceModule {
    const logger = createModuleLogger(MARKETPLACE_MODULE);

    const service = new MarketplaceService({ catalog: deps.catalog, logger });
    const controller = new MarketplaceController(service);

    const viewer: RequestHandler = deps.optionalAuth ?? ((_req, _res, next) => next());

    const router = Router();
    router.get('/', viewer, controller.getFeed);
    router.get('/listings', viewer, controller.listListings);

    return { service, router };
}
