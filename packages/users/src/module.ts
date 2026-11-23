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
import type { IProfileStats } from './domain/profile-stats.port';

export interface UsersModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /** Profile numbers from collections + social, composed at bootstrap. */
    stats?: IProfileStats;
}

export interface UsersModule {
    /** Injected into createAuthModule — auth's port, users' adapter. */
    accountLookup: IAccountLookup;
    service: UserService;
    /** requireAuth comes from the auth module at bootstrap. */
    /**
     * `optionalAuth` lets the public profile routes know who is looking
     * (`viewer.isFollowing`); without it they serve everyone as a guest.
     */
    createRouter(requireAuth: RequestHandler, optionalAuth?: RequestHandler): Router;
}

export function createUsersModule(deps: UsersModuleDeps): UsersModule {
    const logger = createModuleLogger(USERS_MODULE);

    const users = new UserRepository(deps.prisma);
    const service = new UserService({ users, eventBus: deps.eventBus, logger, stats: deps.stats });
    registerAuthEventSubscriptions({ eventBus: deps.eventBus, service, logger });

    return {
        accountLookup: new UserAccountLookup(users, service),
        service,
        createRouter(requireAuth, optionalAuth) {
            const controller = new UserController(service);
            const viewer: RequestHandler = optionalAuth ?? ((_req, _res, next) => next());
            const router = Router();
            router.get('/me', requireAuth, controller.me);
            router.patch('/me', requireAuth, controller.updateMe);
            router.get('/handle/:handle', viewer, controller.getByHandle);
            router.get('/:id', viewer, controller.getById);
            return router;
        },
    };
}
