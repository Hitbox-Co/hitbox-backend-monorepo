import type { Router } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus } from '@hitbox/shared';
import { createAuthModule } from '@hitbox/auth';
import { createUsersModule } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
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

    return buildRoutes({
        auth: authModule.router,
        users: usersModule.createRouter(authModule.requireAuth),
        products: productsModule.createRouter(authModule.requireAuth),
    });
}
