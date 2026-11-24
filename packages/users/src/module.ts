import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger, createRateLimiter } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { IAccountLookup } from '@hitbox/auth';
import { ADDRESS_RATE_LIMIT, USERS_MODULE } from './constants/users.constant';
import { AddressController } from './controller/address.controller';
import { AddressRepository } from './repository/address.repository';
import { AddressService } from './service/address.service';
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
    /**
     * The address book. Payments consumes `resolveForCheckout` through its own
     * port, so checkout and `/users/me/addresses` share one ownership check.
     */
    addresses: AddressService;
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
    const addresses = new AddressService({ addresses: new AddressRepository(deps.prisma), logger });

    return {
        accountLookup: new UserAccountLookup(users, service),
        service,
        addresses,
        createRouter(requireAuth, optionalAuth) {
            const controller = new UserController(service);
            const viewer: RequestHandler = optionalAuth ?? ((_req, _res, next) => next());
            const router = Router();
            router.get('/me', requireAuth, controller.me);
            router.patch('/me', requireAuth, controller.updateMe);

            // Address book. Throttled per signed-in user on top of the global
            // limiter; all of it is the caller's own (no id reaches another
            // user's row). Registered before '/:id' so "me" is never an id.
            const addressController = new AddressController(addresses);
            const perUser = (req: { auth?: { accountId?: string } }) =>
                `user:${req.auth?.accountId ?? 'anonymous'}`;
            const readLimit = createRateLimiter({
                windowMs: ADDRESS_RATE_LIMIT.windowMs,
                max: ADDRESS_RATE_LIMIT.reads,
                prefix: 'addr-read',
                keyGenerator: perUser,
            });
            const writeLimit = createRateLimiter({
                windowMs: ADDRESS_RATE_LIMIT.windowMs,
                max: ADDRESS_RATE_LIMIT.writes,
                prefix: 'addr-write',
                keyGenerator: perUser,
            });
            router.get('/me/addresses', requireAuth, readLimit, addressController.list);
            router.post('/me/addresses', requireAuth, writeLimit, addressController.create);
            router.get('/me/addresses/:id', requireAuth, readLimit, addressController.get);
            router.patch('/me/addresses/:id', requireAuth, writeLimit, addressController.update);
            router.delete('/me/addresses/:id', requireAuth, writeLimit, addressController.archive);
            router.post('/me/addresses/:id/default', requireAuth, writeLimit, addressController.setDefault);
            router.get('/handle/:handle', viewer, controller.getByHandle);
            router.get('/:id', viewer, controller.getById);
            return router;
        },
    };
}
