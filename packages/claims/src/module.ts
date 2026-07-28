import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { CLAIMS_MODULE } from './constants/claims.constant';
import { ClaimsController } from './controller/claims.controller';
import { registerProductEventSubscriptions } from './events/product-event.subscriber';
import { ClaimsRepository } from './repository/claims.repository';
import { ClaimsService } from './service/claims.service';

export interface ClaimsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
}

/** The routers this module owns, mounted at distinct API prefixes. */
export interface ClaimsRouters {
    /** POST /claims/:tagId (validate) + POST /claims/:tagId/confirm (claim). */
    claims: Router;
    /** GET /verify/:tagId — read-only status. */
    verify: Router;
    /** GET /ledger/:tagId — provenance chain. */
    ledger: Router;
}

export interface ClaimsModule {
    service: ClaimsService;
    /** requireAuth comes from the auth module at bootstrap. */
    createRouters(requireAuth: RequestHandler): ClaimsRouters;
}

export function createClaimsModule(deps: ClaimsModuleDeps): ClaimsModule {
    const logger = createModuleLogger(CLAIMS_MODULE);

    const claims = new ClaimsRepository(deps.prisma);
    const service = new ClaimsService({ claims, eventBus: deps.eventBus, logger });

    // Write the "First Time" origin ledger record whenever a tagged product is created.
    registerProductEventSubscriptions({ eventBus: deps.eventBus, service, logger });

    return {
        service,
        createRouters(requireAuth) {
            const controller = new ClaimsController(service);

            // Two-step claim (both authenticated):
            //   POST /claims/:tagId          → validate (which screen to show)
            //   POST /claims/:tagId/confirm  → perform the claim
            const claims = Router();
            claims.post('/:tagId/confirm', requireAuth, controller.confirm);
            claims.post('/:tagId', requireAuth, controller.validate);

            // GET /verify/:tagId — public read
            const verify = Router();
            verify.get('/:tagId', controller.verify);

            // GET /ledger/:tagId — public read
            const ledger = Router();
            ledger.get('/:tagId', controller.ledger);

            return { claims, verify, ledger };
        },
    };
}
