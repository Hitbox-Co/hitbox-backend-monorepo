import { Router } from 'express';
import { createModuleLogger } from '@hitbox/shared';
import { MARKETPLACE_MODULE } from './constants/marketplace.constant';
import { MarketplaceController } from './controller/marketplace.controller';
import type { IListingCatalog } from './domain/interfaces/listing-catalog.interface';
import { MarketplaceService } from './service/marketplace.service';

export interface MarketplaceModuleDeps {
    /** Implemented by the products module, injected at bootstrap. */
    catalog: IListingCatalog;
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

    const router = Router();
    router.get('/', controller.getFeed);
    router.get('/listings', controller.listListings);

    return { service, router };
}
