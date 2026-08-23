import type { Router } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus } from '@hitbox/shared';
import { createAuthModule } from '@hitbox/auth';
import { createAuthzModule } from '@hitbox/authz';
import { createUsersModule, USERS_EVENTS } from '@hitbox/users';
import type { UserDeactivatedPayload, UserProvisionedPayload } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
import { createDiscoverModule } from '@hitbox/discover';
import { createMarketplaceModule } from '@hitbox/marketplace';
import { createCollectionsModule } from '@hitbox/collections';
import { createArtistModule } from '@hitbox/artist';
import { createClaimsModule } from '@hitbox/claims';
import { buildRoutes } from './routes';
import { buildAdminSurface } from './surfaces/admin.surface';
import { buildAppSurface } from './surfaces/app.surface';
import { buildManageSurface } from './surfaces/manage.surface';
import { buildPublicSurface } from './surfaces/public.surface';

export interface Backend {
    router: Router;
    /** Releases module-held resources (cache pub/sub, ...) on shutdown. */
    shutdown(): Promise<void>;
}

/**
 * Composition root — the ONLY place where modules learn about each other.
 *
 * Order matters:
 *   1. users  exposes the account-lookup and user-directory ports
 *   2. auth   consumes account-lookup and produces `requireAuth`   (WHO)
 *   3. authz  consumes user-directory and produces `requirePermission`  (WHAT)
 *   4. every feature module's router is built with BOTH guards
 *
 * Cross-module event wiring also lives here rather than inside the modules, so
 * no package has to depend on another just to subscribe to it.
 */
export function bootstrap(): Backend {
    const usersModule = createUsersModule({ prisma, eventBus });

    // ── Authentication: who is this? ─────────────────────────────────────
    const authModule = createAuthModule({
        prisma,
        eventBus,
        accounts: usersModule.accountLookup,
    });
    const { requireAuth } = authModule;

    // ── Authorization: what may they do? ─────────────────────────────────
    const authzModule = createAuthzModule({
        prisma,
        eventBus,
        users: usersModule.userDirectory,
    });
    const { requirePermission } = authzModule;

    // A newly provisioned user must get the baseline platform role, and a
    // deactivated one must lose their cached permissions immediately. Wired
    // here so users does not depend on authz at runtime, nor authz on users.
    eventBus.subscribe<UserProvisionedPayload>(USERS_EVENTS.USER_PROVISIONED, (payload) =>
        authzModule.roleAssignments.ensureDefaultRole(payload.userId),
    );
    eventBus.subscribe<UserDeactivatedPayload>(USERS_EVENTS.USER_DEACTIVATED, (payload) =>
        authzModule.authorization.invalidate(payload.userId),
    );

    // ── Feature modules ──────────────────────────────────────────────────
    const productsModule = createProductsModule({ prisma, eventBus });

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
    });

    // NFC authenticity domain: single-tap claim, verify a tag, and read the
    // provenance ledger. Owns ProductClaim + BlockchainLedger.
    const claimsModule = createClaimsModule({ prisma, eventBus });

    // ── Routers, built once and shared between surfaces ──────────────────
    const authzRouters = authzModule.createRouters(requireAuth);
    const claimsRouters = claimsModule.createRouters(requireAuth, requirePermission);
    const productsRouter = productsModule.createRouter(requireAuth, requirePermission);
    const usersRouter = usersModule.createRouter(requireAuth, requirePermission);
    const collectionsRouter = collectionsModule.createRouter(requireAuth, requirePermission);

    // The same product router is reachable from three surfaces. That is safe
    // precisely because the routes carry permission + policy checks rather than
    // relying on where the request came from: an artist on the app surface
    // passes via product:update:own, a product manager on /manage via
    // product:update:organization, a platform admin on /admin via
    // product:update:any. One implementation, three legitimate answers.
    const router = buildRoutes({
        public: buildPublicSurface({
            auth: authModule.router,
            discover: discoverModule.router,
            marketplace: marketplaceModule.router,
            verify: claimsRouters.verify,
            ledger: claimsRouters.ledger,
        }),
        app: buildAppSurface({
            authzManifest: authzRouters.manifest,
            users: usersRouter,
            products: productsRouter,
            collections: collectionsRouter,
            claims: claimsRouters.claims,
        }),
        admin: buildAdminSurface({
            authzManifest: authzRouters.manifest,
            authzAdmin: authzRouters.admin,
            organizations: authzRouters.organizations,
            products: productsRouter,
            users: usersRouter,
        }),
        manage: buildManageSurface({
            authzManifest: authzRouters.manifest,
            organizations: authzRouters.organizations,
            products: productsRouter,
        }),
    });

    return {
        router,
        shutdown: () => authzModule.shutdown(),
    };
}
