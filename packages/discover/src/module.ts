import { Router } from 'express';
import { createModuleLogger } from '@hitbox/shared';
import { DISCOVER_MODULE } from './constants/discover.constant';
import { DiscoverController } from './controller/discover.controller';
import type { IProductDiscovery } from './domain/interfaces/product-discovery.interface';
import { DiscoverService } from './service/discover.service';

export interface DiscoverModuleDeps {
    /** Implemented by the products module, injected at bootstrap. */
    catalog: IProductDiscovery;
}

export interface DiscoverModule {
    service: DiscoverService;
    /** All discover routes are public — no auth dependency. */
    router: Router;
}

export function createDiscoverModule(deps: DiscoverModuleDeps): DiscoverModule {
    const logger = createModuleLogger(DISCOVER_MODULE);

    const service = new DiscoverService({ catalog: deps.catalog, logger });
    const controller = new DiscoverController(service);

    const router = Router();
    router.get('/', controller.getFeed);
    router.get('/products', controller.listProducts);

    return { service, router };
}
