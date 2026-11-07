import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { AppError, createModuleLogger, createRateLimiter } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { CLAIMS_ERROR_CODES, CLAIMS_MODULE, TAP_RATE_LIMIT } from './constants/claims.constant';
import { ClaimsController } from './controller/claims.controller';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
import type { INfcTapVerifier } from './domain/interfaces/nfc-tap-verifier.interface';
import { ClaimsRepository } from './repository/claims.repository';
import { ClaimsService } from './service/claims.service';
import { MintLedgerWriter } from './repository/mint-ledger.writer';

export interface ClaimsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /**
     * Resolves a `MediaAsset.storageRef` to a renderable URL. Optional: omit
     * it and the validate screen's `imageUrl` is null rather than failing.
     */
    mediaUrls?: IMediaUrlResolver | undefined;
    /**
     * Overrides CLAIM_TOKEN_REQUIRED. For tests, which need both sides of the
     * flag without touching process.env; bootstrap leaves it unset.
     */
    claimTokenRequired?: boolean;
    /**
     * Hashes a chip UID with the deployment's tag key, so a tap can resolve
     * units minted from supply consignments. Absent when no key is configured;
     * taps then resolve legacy `Sku.tagId` only.
     */
    tagUidHash?: ((uid: string) => string) | undefined;
    /**
     * Authenticates a tap URL (b/e/c) — the skus module's verifier. Absent when
     * no key wrapper or chip-UID key is configured; POST /claim and
     * GET /verify?b=&e=&c= then answer 503.
     */
    tapVerifier?: INfcTapVerifier | undefined;
    /**
     * Keep the old tag-id routes (POST /claims/:tagId, /confirm and
     * GET /verify/:tagId) answering. Default true. They are deprecated; false
     * makes them answer 410.
     */
    legacyTagIdRoutes?: boolean | undefined;
}

/** The routers this module owns, mounted at distinct API prefixes. */
export interface ClaimsRouters {
    /** POST /claim — claim with a tap URL's b/e/c. */
    claim: Router;
    /** POST /claims/:tagId (validate) + POST /claims/:tagId/confirm (claim). */
    claims: Router;
    /** GET /verify?b=&e=&c= (tap URL) and the deprecated GET /verify/:tagId. */
    verify: Router;
    /** GET /ledger/:tagId — provenance chain. */
    ledger: Router;
}

export interface ClaimsModule {
    service: ClaimsService;
    /**
     * Payments' `IClaimRevocation`: take ownership back when a refund or a
     * lost dispute means the buyer no longer has the item. Structural, not an
     * import — claims is the provider here and bootstrap connects the two.
     */
    revocation: Pick<ClaimsService, 'revokeClaim'>;
    /**
     * Skus' `ISkuMintLedger`: writes each new unit's MINT ledger record
     * inside the minting transaction, so no unit exists without one.
     */
    mintLedger: MintLedgerWriter;
    /** requireAuth comes from the auth module at bootstrap. */
    createRouters(requireAuth: RequestHandler): ClaimsRouters;
}

export function createClaimsModule(deps: ClaimsModuleDeps): ClaimsModule {
    const logger = createModuleLogger(CLAIMS_MODULE);

    const claims = new ClaimsRepository(deps.prisma, deps.tagUidHash);
    const service = new ClaimsService({
        claims,
        eventBus: deps.eventBus,
        logger,
        mediaUrls: deps.mediaUrls,
        claimTokenRequired: deps.claimTokenRequired ?? (process.env.CLAIM_TOKEN_REQUIRED === 'true'),
        tapVerifier: deps.tapVerifier,
    });

    // The MINT row is written when a unit is minted, inside the minting
    // transaction (`mintLedger` below, called by the skus module). The lazy
    // origin paths — inside the claim transaction and
    // `service.ensureOriginForSku(skuId)` — remain for units minted before
    // that existed; for every newer unit they find the row and no-op.

    return {
        service,
        revocation: service,
        mintLedger: new MintLedgerWriter(),
        createRouters(requireAuth) {
            const controller = new ClaimsController(service);

            // The tag-id routes are deprecated in favour of the tap-URL routes
            // below. They keep working unless CLAIMS_LEGACY_TAG_ROUTES=false.
            const legacyEnabled = deps.legacyTagIdRoutes !== false;
            const legacy: RequestHandler = (_req, res, next) => {
                if (!legacyEnabled) {
                    next(
                        new AppError(
                            'This route has been retired. Use POST /api/v1/claim or GET /api/v1/verify?b=&e=&c=.',
                            410,
                            CLAIMS_ERROR_CODES.LEGACY_ROUTE_DISABLED,
                        ),
                    );
                    return;
                }
                res.setHeader('Deprecation', 'true');
                next();
            };

            // Tap-URL routes. Throttled on top of the global limiter: each
            // attempt costs a KMS unwrap and a database write, and a forged
            // URL is the cheapest thing an attacker can send.
            const tapLimit = { windowMs: TAP_RATE_LIMIT.windowMs };
            const ipLimit = createRateLimiter({ ...tapLimit, max: TAP_RATE_LIMIT.perIp, prefix: 'tap-ip' });
            const userLimit = createRateLimiter({
                ...tapLimit,
                max: TAP_RATE_LIMIT.perUser,
                prefix: 'tap-user',
                keyGenerator: (req) => `user:${req.auth?.accountId ?? 'anonymous'}`,
            });

            // Two-step claim (both authenticated):
            //   POST /claims/:tagId          → validate (which screen to show)
            //   POST /claims/:tagId/confirm  → perform the claim
            const claims = Router();
            claims.post('/:tagId/confirm', legacy, requireAuth, controller.confirm);
            claims.post('/:tagId', legacy, requireAuth, controller.validate);

            // POST /claim — claim with the tap URL's own b/e/c (auth).
            const claim = Router();
            claim.post('/', ipLimit, requireAuth, userLimit, controller.claimTap);

            // GET /verify?b=&e=&c= — public, from a tap URL. Registered before
            // the :tagId route; a bare /verify never reaches it.
            const verify = Router();
            verify.get('/', ipLimit, controller.verifyTap);
            // GET /verify/:tagId — public read. DEPRECATED.
            verify.get('/:tagId', legacy, controller.verify);

            // GET /ledger/:tagId — public read
            const ledger = Router();
            ledger.get('/:tagId', controller.ledger);

            return { claim, claims, verify, ledger };
        },
    };
}
