import { randomUUID } from 'node:crypto';
import type { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_ERROR_CODES,
    STRIPE_EVENT_MAP,
} from '../constants/payments.constant';
import { verifyStripeSignature } from '../domain/webhook-signature';
import type { PaymentRepository } from '../repository/payment.repository';
import type { WebhookRepository } from '../repository/webhook.repository';
import type { DisputeService } from './dispute.service';
import type { PaymentService } from './payment.service';
import type { RefundService } from './refund.service';

export interface WebhookServiceDeps {
    webhooks: WebhookRepository;
    payments: PaymentRepository;
    paymentService: PaymentService;
    refunds: RefundService;
    disputes: DisputeService;
    signingSecret: string;
    toleranceSeconds: number;
    logger: Logger;
}

/** What the endpoint tells the provider. */
export interface WebhookOutcome {
    received: true;
    /** False when the delivery was a replay of one already processed. */
    processed: boolean;
    eventId: string;
}

/**
 * Webhook ingestion: verify, record, then act — in that order, always.
 *
 * The design document asks for one property here — *"If Stripe webhook
 * retried, webhook_id already exists → skipped (no duplicate charge)"* — and
 * this class is where it is enforced, with two separate mechanisms that fail
 * in different ways on purpose:
 *
 *   **The signature** decides whether the delivery is real. It is checked
 *   before anything is written, because an unverified payment webhook is a way
 *   to mark any order paid, and storing one would put attacker-controlled JSON
 *   in the replay queue.
 *
 *   **The event id** decides whether it is new. It is the primary key of
 *   `PaymentWebhookEvent`, so the insert itself is the duplicate check — no
 *   read-then-write window two concurrent deliveries could both pass through.
 *
 * A delivery whose *processing* fails keeps its row, unprocessed, with the
 * error on it. That is the replay queue: dropping a webhook that could not be
 * processed is how an order silently never gets marked paid.
 */
export class WebhookService {
    constructor(private readonly deps: WebhookServiceDeps) { }

    async handleStripe(input: {
        rawBody: Buffer | string;
        signatureHeader: string | undefined;
    }): Promise<WebhookOutcome> {
        const verification = verifyStripeSignature({
            rawBody: input.rawBody,
            signatureHeader: input.signatureHeader,
            secret: this.deps.signingSecret,
            toleranceSeconds: this.deps.toleranceSeconds,
        });

        if (!verification.verified) {
            // Nothing is stored and nothing is echoed back. A 400 with the
            // reason in it would tell whoever is probing the endpoint exactly
            // which part of the forgery to fix.
            this.deps.logger.warn(
                { reason: verification.reason },
                'rejected payment webhook with an invalid signature',
            );
            throw AppError.badRequest(
                'Signature verification failed.',
                PAYMENTS_ERROR_CODES.INVALID_SIGNATURE,
            );
        }

        const payload = this.parse(input.rawBody);
        const eventId = typeof payload.id === 'string' ? payload.id : null;
        const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';
        if (!eventId) {
            throw AppError.badRequest(
                'Webhook payload has no event id.',
                PAYMENTS_ERROR_CODES.INVALID_SIGNATURE,
            );
        }

        const { created } = await this.deps.webhooks.record({
            id: eventId,
            provider: 'STRIPE',
            eventType,
            payload: payload as Prisma.InputJsonValue,
            signatureVerified: true,
            receivedAt: new Date(),
        });

        if (!created) {
            this.deps.logger.info({ eventId, eventType }, 'webhook replay ignored');
            return { received: true, processed: false, eventId };
        }

        try {
            await this.dispatch(eventType, payload);
            await this.deps.webhooks.markProcessed(eventId, new Date());
            return { received: true, processed: true, eventId };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.deps.webhooks.markFailed(eventId, message);
            this.deps.logger.error(
                { err: error, eventId, eventType },
                'webhook processing failed — kept for replay',
            );
            // Re-thrown so the provider retries. The row is already recorded,
            // so the retry will be seen as a replay and skipped — which is why
            // the replay queue exists and is drained deliberately rather than
            // by hoping the provider tries again.
            throw error;
        }
    }

    /**
     * Routes a provider event to whatever owns that consequence.
     *
     * An event type this system does not care about is a no-op, not an error:
     * a webhook endpoint that 400s on an event it did not ask for is an
     * endpoint the provider eventually disables, taking the ones that matter
     * with it.
     */
    private async dispatch(eventType: string, payload: Record<string, unknown>): Promise<void> {
        const action = STRIPE_EVENT_MAP[eventType];
        if (!action) {
            this.deps.logger.debug({ eventType }, 'webhook event type not handled');
            return;
        }

        const object = this.objectOf(payload);
        const correlationId = randomUUID();

        switch (action) {
            case 'PAYMENT_SUCCEEDED': {
                const transaction = await this.resolveTransaction(object);
                if (!transaction) return;
                await this.deps.paymentService.settle({
                    transaction,
                    gatewayRef: this.stringField(object, 'id'),
                    gatewayFee: this.feeOf(object),
                    settledAt: this.timestampOf(payload),
                    correlationId,
                });
                return;
            }
            case 'PAYMENT_FAILED': {
                const transaction = await this.resolveTransaction(object);
                if (!transaction) return;
                await this.deps.paymentService.fail({
                    transaction,
                    reason:
                        this.stringField(
                            object['last_payment_error'] as Record<string, unknown> | undefined,
                            'message',
                        ) ?? 'The payment provider declined the charge.',
                    correlationId,
                });
                return;
            }
            case 'REFUND_SETTLED': {
                const refundId = this.stringField(object, 'id');
                if (refundId) {
                    await this.deps.refunds.confirmSettlementFromGateway({
                        gatewayRefundId: refundId,
                        processedAt: this.timestampOf(payload),
                        correlationId,
                    });
                }
                return;
            }
            case 'DISPUTE_OPENED':
                await this.deps.disputes.openFromGateway({
                    object,
                    correlationId,
                });
                return;
            case 'DISPUTE_CLOSED':
                await this.deps.disputes.closeFromGateway({
                    object,
                    correlationId,
                });
                return;
            default:
                return;
        }
    }

    // ── payload helpers ─────────────────────────────────────────────────────

    private parse(rawBody: Buffer | string): Record<string, unknown> {
        try {
            const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
            return parsed as Record<string, unknown>;
        } catch {
            throw AppError.badRequest(
                'Webhook payload is not valid JSON.',
                PAYMENTS_ERROR_CODES.INVALID_SIGNATURE,
            );
        }
    }

    /** Stripe nests the interesting part at `data.object`. */
    private objectOf(payload: Record<string, unknown>): Record<string, unknown> {
        const data = payload['data'];
        if (typeof data === 'object' && data !== null) {
            const object = (data as Record<string, unknown>)['object'];
            if (typeof object === 'object' && object !== null) {
                return object as Record<string, unknown>;
            }
        }
        return {};
    }

    /**
     * Finds the charge this event is about.
     *
     * Two routes, in order of trustworthiness: the metadata this system put on
     * the charge itself, then the provider reference recorded at checkout.
     * Neither matching is a real possibility — a charge created outside this
     * platform, a test event fired from a dashboard — and it is logged rather
     * than thrown, because there is nothing here to retry.
     */
    private async resolveTransaction(object: Record<string, unknown>) {
        const metadata = object['metadata'];
        const transactionId =
            typeof metadata === 'object' && metadata !== null
                ? this.stringField(
                    metadata as Record<string, unknown>,
                    'paymentTransactionId',
                )
                : null;

        if (transactionId) {
            const byId = await this.deps.payments.findById(transactionId);
            if (byId) return byId;
        }

        const gatewayRef = this.stringField(object, 'id');
        if (gatewayRef) {
            const byRef = await this.deps.payments.findByGatewayRef(gatewayRef);
            if (byRef) return byRef;
        }

        this.deps.logger.warn(
            { gatewayRef, transactionId },
            'webhook referenced a charge this platform does not know',
        );
        return null;
    }

    private stringField(
        object: Record<string, unknown> | undefined,
        key: string,
    ): string | null {
        if (!object) return null;
        const value = object[key];
        return typeof value === 'string' ? value : null;
    }

    /** The provider's own fee on the charge, in major units, if present. */
    private feeOf(object: Record<string, unknown>): string | null {
        const details = object['balance_transaction_details'];
        if (typeof details === 'object' && details !== null) {
            const fee = (details as Record<string, unknown>)['fee'];
            if (typeof fee === 'number') return (fee / 100).toFixed(2);
        }
        return null;
    }

    private timestampOf(payload: Record<string, unknown>): Date {
        const created = payload['created'];
        return typeof created === 'number' ? new Date(created * 1000) : new Date();
    }
}
