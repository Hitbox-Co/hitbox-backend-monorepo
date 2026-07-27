import type { Router } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus } from '@hitbox/shared';
import { createAuthModule } from '@hitbox/auth';
import { createUsersModule } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
import { createDiscoverModule } from '@hitbox/discover';
import { createMarketplaceModule } from '@hitbox/marketplace';
import { createCollectionsModule } from '@hitbox/collections';
import { createArtistModule } from '@hitbox/artist';
import { createClaimsModule } from '@hitbox/claims';
import { buildRoutes } from './routes';

/**
 * Composition root — the ONLY place where modules learn about each other.
 * Order matters: users exposes the account-lookup port, auth consumes it,
 * then every module's router is built with auth's requireAuth middleware.
 */
export function bootstrap(): Router {
    const usersModule = createUsersModule({ prisma, eventBus });

    const authModule = createAuthModule({
        prisma,
        eventBus,
        accounts: usersModule.accountLookup,
    });

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
    const claimsRouters = claimsModule.createRouters(authModule.requireAuth);

    return buildRoutes({
        auth: authModule.router,
        users: usersModule.createRouter(authModule.requireAuth),
        products: productsModule.createRouter(authModule.requireAuth),
        discover: discoverModule.router,
        marketplace: marketplaceModule.router,
        collections: collectionsModule.createRouter(authModule.requireAuth),
        claims: claimsRouters.claims,
        verify: claimsRouters.verify,
        ledger: claimsRouters.ledger,
    });
}
