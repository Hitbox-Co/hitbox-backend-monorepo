import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { IProductDiscovery } from '@hitbox/discover';
import { createModuleLogger, createRateLimiter } from '@hitbox/shared';
import { SEARCH_MODULE, SEARCH_RATE_LIMIT } from './constants/search.constant';
import { SearchController } from './controller/search.controller';
import type { IUserSearch } from './domain/interfaces/user-search.interface';
import { SearchService } from './service/search.service';

export interface SearchModuleDeps {
    /** Products and artists — implemented by the products module. */
    catalog: IProductDiscovery;
    /** Collectors — implemented by the users module. */
    users: IUserSearch;
    /**
     * Auth's optional-auth middleware. Attaches `req.auth` when a valid session
     * is sent, so cards carry `isWishlisted` and the viewer is left out of the
     * people results; never rejects. Omitted → every request is a guest.
     */
    optionalAuth?: RequestHandler;
}

export interface SearchModule {
    service: SearchService;
    /** Public; auth only personalises. */
    router: Router;
}

export function createSearchModule(deps: SearchModuleDeps): SearchModule {
    const logger = createModuleLogger(SEARCH_MODULE);
    const service = new SearchService({ catalog: deps.catalog, users: deps.users, logger });
    const controller = new SearchController(service);
    const viewer: RequestHandler = deps.optionalAuth ?? ((_req, _res, next) => next());

    const router = Router();
    router.get(
        '/',
        createRateLimiter({ prefix: 'search', ...SEARCH_RATE_LIMIT }),
        viewer,
        controller.search,
    );

    return { service, router };
}
