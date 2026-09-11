import { Router } from 'express';
import type { Request } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus, env } from '@hitbox/shared';
import { createAuthModule } from '@hitbox/auth';
import { createAccessControlModule } from '@hitbox/access-control';
import { createDashboardModule } from '@hitbox/dashboard';
import { createMediaModule, isPublicKey, S3ObjectStorage } from '@hitbox/media';
import { createUsersModule } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
import { createDiscoverModule } from '@hitbox/discover';
import { createMarketplaceModule } from '@hitbox/marketplace';
import { createCollectionsModule } from '@hitbox/collections';
import { createArtistModule } from '@hitbox/artist';
import { createClaimsModule } from '@hitbox/claims';
import { createLeadsModule } from '@hitbox/leads';
import { buildRoutes } from './routes';

export interface Bootstrapped {
    /** Mobile platform routes, mounted at /api/v1 (see app.ts). */
    apiRouter: Router;
    /**
     * Public website (lead capture) routes, mounted at /app/web/v1 — a
     * separate route namespace on this SAME server/port, not a separate app.
     * Owns its own database (@hitbox/leads); everything else in this file
     * shares the mobile platform's @hitbox/database.
     */
    leadsRouter: Router;
    /**
     * Subscribes the authorization cache to cross-instance invalidation
     * broadcasts. Until this runs, each process still caches locally but only
     * learns about another instance's revoke when its short L1 TTL lapses.
     */
    startCaches(): Promise<void>;
    /** Releases cache pub/sub connections on graceful shutdown. */
    stopCaches(): Promise<void>;
}

/**
 * Composition root — the ONLY place where modules learn about each other.
 * Order matters: users exposes the account-lookup port, auth consumes it,
 * then every module's router is built with auth's requireAuth middleware.
 */
export function bootstrap(): Bootstrapped {
    const usersModule = createUsersModule({ prisma, eventBus });

    const authModule = createAuthModule({
        prisma,
        eventBus,
        accounts: usersModule.accountLookup,
    });

    // Authorization. Depends on nothing but prisma + the event bus; the
    // principal resolver is the adapter that lets it read the authenticated
    // account without importing @hitbox/auth (see §6 of the architecture doc
    // — consumer defines the port, bootstrap connects it).
    const accessControlModule = createAccessControlModule({
        prisma,
        eventBus,
        resolvePrincipalId: (req) => req.auth?.accountId,
    });

    // The dashboard reads the caller's grants through the guard's own
    // per-request memo — one permission load serves a dozen section checks.
    const dashboardModule = createDashboardModule({
        prisma,
        resolvePrincipal: (req) => accessControlModule.guard.describePrincipal(req),
    });

    // Media needs a bucket. Without one the routes are not mounted at all
    // rather than mounted-but-broken: an upload endpoint that 500s after
    // creating a MediaAsset row leaves orphaned registry entries behind.
    //
    // No `scanPipeline` and no `scanCallback` — this deployment runs no
    // scanner and no SQS queue, so assets are created SKIPPED and are
    // servable immediately, and POST /scan-result is not mounted. See
    // docs/media/s3-configuration.md §8.
    const objectStorage = env.MEDIA_S3_BUCKET
        ? new S3ObjectStorage({
            bucket: env.MEDIA_S3_BUCKET,
            // ap-south-1 in production. The fallback only keeps a
            // half-configured local deploy from crashing at boot — a
            // wrong region makes presigned URLs fail at S3, not here.
            region: env.MEDIA_S3_REGION ?? 'us-east-1',
            endpoint: env.MEDIA_S3_ENDPOINT,
            forcePathStyle: Boolean(env.MEDIA_S3_ENDPOINT),
            publicBaseUrl: env.MEDIA_S3_PUBLIC_BASE_URL,
        })
        : null;

    /**
     * Products' IMediaUrlResolver port. The catalog stores image *keys*
     * (`ProductImage → MediaAsset.storageRef`) and needs URLs to render; only
     * this adapter knows the bucket and which prefixes are public.
     *
     * `isPublicKey` is the gate: a private key returns null rather than a URL
     * that would 403, because a public catalog feed cannot sign a GET. Product
     * images live under `drop-images/`, so in practice this always resolves.
     */
    const mediaUrls = objectStorage
        ? { publicUrl: (ref: string) => (isPublicKey(ref) ? objectStorage.publicUrl(ref) : null) }
        : undefined;

    const mediaModule = env.MEDIA_S3_BUCKET && objectStorage
        ? createMediaModule({
            prisma,
            guard: accessControlModule.guard,
            storage: objectStorage,
            bucket: env.MEDIA_S3_BUCKET,
            resolveCaller: async (req: Request) => {
                const principal = await accessControlModule.guard.describePrincipal(req);
                const orgIds = [
                    ...new Set(
                        principal.roles
                            .map((role) => role.organizationId)
                            .filter((id): id is string => id !== null),
                    ),
                ];
                // A caller holding the capability globally is unrestricted;
                // otherwise they are confined to their own organizations.
                const global = principal.permissions.includes(
                    'assets-documents-upload:manage:global',
                );
                return { userId: principal.userId, organizationIds: global ? null : orgIds };
            },
        })
        : null;

    const productsModule = createProductsModule({ prisma, eventBus, mediaUrls });

    const discoverModule = createDiscoverModule({
        catalog: productsModule.discovery,
    });

    const marketplaceModule = createMarketplaceModule({
        catalog: productsModule.listings,
    });

    // Artist provides ArtistCollection capacity; collections consumes it for
    // the buyer collection-progress stat.
    const artistModule = createArtistModule({ prisma });

    const collectionsModule = createCollectionsModule({
        prisma,
        artistStats: artistModule.collectionStats,
        mediaUrls,
    });

    // NFC authenticity domain: single-tap claim, verify a tag, and read the
    // provenance ledger. Owns ProductClaim + BlockchainLedger.
    const claimsModule = createClaimsModule({ prisma, eventBus });
    const claimsRouters = claimsModule.createRouters(authModule.requireAuth);

    const apiRouter = buildRoutes({
        auth: authModule.router,
        users: usersModule.createRouter(authModule.requireAuth),
        products: productsModule.createRouter(authModule.requireAuth),
        discover: discoverModule.router,
        marketplace: marketplaceModule.router,
        collections: collectionsModule.createRouter(authModule.requireAuth),
        claims: claimsRouters.claims,
        verify: claimsRouters.verify,
        ledger: claimsRouters.ledger,
        authz: accessControlModule.createSelfRouter(authModule.requireAuth),
        adminAuthz: accessControlModule.createAdminRouter(authModule.requireAuth),
        adminDashboard: dashboardModule.createRouter(authModule.requireAuth),
        adminMedia: mediaModule
            ? mediaModule.createRouter(authModule.requireAuth)
            : mediaUnavailableRouter(),
    });

    // Public website (hitboxcollectibles.com) — its own database, no
    // dependency on anything above. See docs/repo-structure.md.
    const leadsModule = createLeadsModule();

    return {
        apiRouter,
        leadsRouter: leadsModule.router,
        startCaches: () => accessControlModule.startCache(),
        stopCaches: () => accessControlModule.stopCache(),
    };
}

/**
 * Stands in for the media routes when no bucket is configured, so a
 * misconfigured deploy returns a clear 503 rather than a confusing 404 that
 * looks like the feature was never built.
 */
function mediaUnavailableRouter(): Router {
    const router = Router();
    router.use((_req, res) => {
        res.status(503).json({
            error: {
                code: 'STORAGE_UNAVAILABLE',
                message: 'Media storage is not configured on this deployment.',
                details: null,
            },
        });
    });
    return router;
}
