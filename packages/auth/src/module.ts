import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger, env } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { AUTH_MODULE, CLERK_WEBHOOK_PATH } from './constants/auth.constant';
import { AuthController } from './controller/auth.controller';
import type { IAccountLookup } from './domain/interfaces/account-lookup.interface';
import { createRequireAuth } from './middleware/require-auth.middleware';
import { WebhookEventRepository } from './repository/webhook-event.repository';
import { AuthWebhookService } from './service/auth-webhook.service';

export interface AuthModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /** Implemented by the users module, injected at bootstrap. */
    accounts: IAccountLookup;
}

export interface AuthModule {
    router: Router;
    /** Mountable on any route in any module that needs an authenticated user. */
    requireAuth: RequestHandler;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
    const logger = createModuleLogger(AUTH_MODULE);

    const webhookEvents = new WebhookEventRepository(deps.prisma);
    const webhookService = new AuthWebhookService({
        webhookEvents,
        eventBus: deps.eventBus,
        signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
        logger,
    });
    const controller = new AuthController(webhookService);
    const requireAuth = createRequireAuth({ accounts: deps.accounts });

    const router = Router();
    router.post(`/webhooks${CLERK_WEBHOOK_PATH}`, controller.handleClerkWebhook);
    router.get('/me', requireAuth, controller.me);

    return { router, requireAuth };
}
