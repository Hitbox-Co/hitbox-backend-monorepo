import { Webhook } from 'svix';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { AUTH_ERROR_CODES, AUTH_EVENTS, HANDLED_CLERK_EVENTS } from '../constants/auth.constant';
import {
    clerkDeletedUserPayloadSchema,
    clerkUserPayloadSchema,
    clerkWebhookEnvelopeSchema,
    resolvePrimaryEmail,
} from '../dto/clerk-webhook.dto';
import type { UserDeletedPayload, UserRegisteredPayload } from '../events/auth-event.payloads';
import type { WebhookEventRepository } from '../repository/webhook-event.repository';

export interface SvixHeaders {
    'svix-id': string;
    'svix-timestamp': string;
    'svix-signature': string;
}

interface AuthWebhookServiceDeps {
    webhookEvents: WebhookEventRepository;
    eventBus: IEventBus;
    signingSecret: string;
    logger: Logger;
}

/**
 * Verifies, deduplicates and translates Clerk webhooks into domain events.
 * Nothing outside this service ever sees a Clerk payload shape.
 */
export class AuthWebhookService {
    constructor(private readonly deps: AuthWebhookServiceDeps) { }

    async processClerkWebhook(rawBody: string, headers: Partial<SvixHeaders>): Promise<void> {
        const { webhookEvents, eventBus, signingSecret, logger } = this.deps;

        const svixId = headers['svix-id'];
        if (!svixId || !headers['svix-timestamp'] || !headers['svix-signature']) {
            throw AppError.unauthorized(
                'Missing webhook signature headers',
                AUTH_ERROR_CODES.WEBHOOK_INVALID_SIGNATURE,
            );
        }

        let verified: unknown;
        try {
            verified = new Webhook(signingSecret).verify(rawBody, headers as SvixHeaders);
        } catch {
            throw AppError.unauthorized(
                'Invalid webhook signature',
                AUTH_ERROR_CODES.WEBHOOK_INVALID_SIGNATURE,
            );
        }

        // Svix retries deliveries; presence in the ledger means already handled.
        if (await webhookEvents.hasProcessed(svixId)) {
            logger.info({ svixId }, 'duplicate webhook delivery ignored');
            return;
        }

        const envelope = clerkWebhookEnvelopeSchema.parse(verified);

        if ((HANDLED_CLERK_EVENTS as readonly string[]).includes(envelope.type)) {
            await this.dispatch(envelope.type, envelope.data);
        } else {
            logger.debug({ type: envelope.type }, 'unhandled clerk event ignored');
        }

        await webhookEvents.markProcessed(svixId, envelope.type, envelope.data);
    }

    private async dispatch(type: string, data: Record<string, unknown>): Promise<void> {
        const { eventBus, logger } = this.deps;

        if (type === 'user.deleted') {
            const payload = clerkDeletedUserPayloadSchema.parse(data);
            await eventBus.publish<UserDeletedPayload>(AUTH_EVENTS.USER_DELETED, {
                clerkUserId: payload.id,
            });
            return;
        }

        const user = clerkUserPayloadSchema.parse(data);
        const email = resolvePrimaryEmail(user);
        if (!email) {
            logger.warn({ clerkUserId: user.id, type }, 'clerk user has no email — skipped');
            return;
        }

        const payload: UserRegisteredPayload = {
            clerkUserId: user.id,
            email,
            username: user.username ?? null,
            firstName: user.first_name ?? null,
            lastName: user.last_name ?? null,
            avatarUrl: user.image_url ?? null,
        };

        await eventBus.publish(
            type === 'user.created' ? AUTH_EVENTS.USER_REGISTERED : AUTH_EVENTS.USER_UPDATED,
            payload,
        );
    }
}
