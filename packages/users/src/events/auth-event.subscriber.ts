import type { Logger } from 'pino';
import type { IEventBus } from '@hitbox/shared';
import { AUTH_EVENTS } from '@hitbox/auth';
import type {
    UserDeletedPayload,
    UserRegisteredPayload,
    UserUpdatedPayload,
} from '@hitbox/auth';
import type { UserService } from '../service/user.service';

interface SubscriberDeps {
    eventBus: IEventBus;
    service: UserService;
    logger: Logger;
}

/** Projects auth-module events into the local users table. */
export function registerAuthEventSubscriptions(deps: SubscriberDeps): void {
    const { eventBus, service, logger } = deps;

    eventBus.subscribe<UserRegisteredPayload>(AUTH_EVENTS.USER_REGISTERED, (payload) =>
        service.syncFromClerk(payload),
    );
    eventBus.subscribe<UserUpdatedPayload>(AUTH_EVENTS.USER_UPDATED, (payload) =>
        service.syncFromClerk(payload),
    );
    eventBus.subscribe<UserDeletedPayload>(AUTH_EVENTS.USER_DELETED, (payload) =>
        service.markDeleted(payload),
    );

    logger.debug('users module subscribed to auth events');
}
