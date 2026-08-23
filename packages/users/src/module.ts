import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { IAccountLookup } from '@hitbox/auth';
import type { RequirePermission } from '@hitbox/authz';
import { USERS_MODULE } from './constants/users.constant';
import { UserController } from './controller/user.controller';
import { UserAccountLookup } from './domain/account-lookup.adapter';
import { UserDirectory } from './domain/user-directory.adapter';
import { registerAuthEventSubscriptions } from './events/auth-event.subscriber';
import { UserRepository } from './repository/user.repository';
import { UserService } from './service/user.service';

export interface UsersModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
}

export interface UsersModule {
    /** Injected into createAuthModule — auth's port, users' adapter. */
    accountLookup: IAccountLookup;
    /** Injected into createAuthzModule — authz's IUserDirectory port. */
    userDirectory: UserDirectory;
    service: UserService;
    /** requireAuth from @hitbox/auth, requirePermission from @hitbox/authz. */
    createRouter(requireAuth: RequestHandler, requirePermission: RequirePermission): Router;
}

export function createUsersModule(deps: UsersModuleDeps): UsersModule {
    const logger = createModuleLogger(USERS_MODULE);

    const users = new UserRepository(deps.prisma);
    const service = new UserService({ users, eventBus: deps.eventBus, logger });
    registerAuthEventSubscriptions({ eventBus: deps.eventBus, service, logger });

    return {
        accountLookup: new UserAccountLookup(users),
        userDirectory: new UserDirectory(users),
        service,
        createRouter(requireAuth, requirePermission) {
            const controller = new UserController(service);
            const router = Router();
            // Both handlers read req.auth.accountId, so the subject is always
            // the caller — profile:*:own is satisfied by the capability check.
            router.get('/me', requireAuth, requirePermission('profile', 'read'), controller.me);
            router.patch(
                '/me',
                requireAuth,
                requirePermission('profile', 'update'),
                controller.updateMe,
            );
            // Public profile card — intentionally unauthenticated.
            router.get('/:id', controller.getById);
            return router;
        },
    };
}
