import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { CLAIMS_MODULE } from './constants/claims.constant';
import { ClaimsController } from './controller/claims.controller';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
import { ClaimsRepository } from './repository/claims.repository';
import { ClaimsService } from './service/claims.service';

export interface ClaimsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /**
     * Resolves a `MediaAsset.storageRef` to a renderable URL. Optional: omit
     * it and the validate screen's `imageUrl` is null rather than failing.
     */
    mediaUrls?: IMediaUrlResolver | undefined;
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
    const service = new ClaimsService({
        claims,
        eventBus: deps.eventBus,
        logger,
        mediaUrls: deps.mediaUrls,
    });

    // No product-created subscription any more. It wrote the "First Time"
    // origin ledger row for a tagged product, but tags moved to Sku: a product
    // carries none, and its SKUs do not exist when it is created, so the
    // handler could only ever no-op. The MINT row is written lazily inside the
    // claim transaction instead, and `service.ensureOriginForSku(skuId)` is
    // the hook for the skus module to call when it binds a tag.

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
