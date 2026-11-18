import { Router } from 'express';
import type { RequestHandler } from 'express';
import { createModuleLogger } from '@hitbox/shared';
import { DISCOVER_MODULE } from './constants/discover.constant';
import { DiscoverController } from './controller/discover.controller';
import type { IProductDiscovery } from './domain/interfaces/product-discovery.interface';
import { DiscoverService } from './service/discover.service';

export interface DiscoverModuleDeps {
    /** Implemented by the products module, injected at bootstrap. */
    catalog: IProductDiscovery;
    /**
     * Auth's optional-auth middleware. Attaches `req.auth` when a valid
     * session is sent, so cards can carry `isWishlisted`; never rejects.
     * Omitted → every request is served as a guest.
     */
    optionalAuth?: RequestHandler;
}

export interface DiscoverModule {
    service: DiscoverService;
    /** All discover routes are public — auth only personalises. */
    router: Router;
}

export function createDiscoverModule(deps: DiscoverModuleDeps): DiscoverModule {
    const logger = createModuleLogger(DISCOVER_MODULE);

    const service = new DiscoverService({ catalog: deps.catalog, logger });
    const controller = new DiscoverController(service);
    const viewer: RequestHandler = deps.optionalAuth ?? ((_req, _res, next) => next());

    const router = Router();
    router.get('/', viewer, controller.getFeed);
    router.get('/products', viewer, controller.listProducts);
    router.get('/creators', controller.listCreators);

    return { service, router };
}
