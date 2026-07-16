import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { IAccountLookup } from '@hitbox/auth';
import { USERS_MODULE } from './constants/users.constant';
import { UserController } from './controller/user.controller';
import { UserAccountLookup } from './domain/account-lookup.adapter';
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
    service: UserService;
    /** requireAuth comes from the auth module at bootstrap. */
    createRouter(requireAuth: RequestHandler): Router;
}

export function createUsersModule(deps: UsersModuleDeps): UsersModule {
    const logger = createModuleLogger(USERS_MODULE);

    const users = new UserRepository(deps.prisma);
    const service = new UserService({ users, logger });
    registerAuthEventSubscriptions({ eventBus: deps.eventBus, service, logger });

    return {
        accountLookup: new UserAccountLookup(users),
        service,
        createRouter(requireAuth) {
            const controller = new UserController(service);
            const router = Router();
            router.get('/me', requireAuth, controller.me);
            router.patch('/me', requireAuth, controller.updateMe);
            router.get('/:id', controller.getById);
            return router;
        },
    };
}
