import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WebhookService } from '../src/service/webhook.service';

const SECRET = 'whsec_test_secret_value';

function sign(body: string, secret = SECRET): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return `t=${timestamp},v1=${signature}`;
}

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as never;

/**
 * A fake webhook table with the property that matters: the provider's event id
 * is the PRIMARY KEY, so the insert is the duplicate check.
 */
function makeWebhooks() {
    const seen = new Map<string, Record<string, unknown>>();
    return {
        seen,
        record: jest.fn(async (data: Record<string, unknown>) => {
            const id = data.id as string;
            if (seen.has(id)) return { event: seen.get(id) as never, created: false };
            seen.set(id, data);
            return { event: data as never, created: true };
        }),
        markProcessed: jest.fn(async () => undefined as never),
        markFailed: jest.fn(async () => undefined as never),
    };
}

const TRANSACTION = {
    id: 'txn-1',
    orderId: 'order-1',
    status: 'PENDING',
    amount: { toFixed: () => '100.00' },
    currency: 'USD',
    gateway: 'STRIPE',
};

function build() {
    const webhooks = makeWebhooks();
    const settle = jest.fn(async () => ({ settled: true }));
    const fail = jest.fn(async () => ({ failed: true }));

    const service = new WebhookService({
        webhooks: webhooks as never,
        payments: {
            findById: jest.fn(async () => TRANSACTION as never),
            findByGatewayRef: jest.fn(async () => TRANSACTION as never),
        } as never,
        paymentService: { settle, fail } as never,
        refunds: { confirmSettlementFromGateway: jest.fn(async () => undefined) } as never,
        disputes: {
            openFromGateway: jest.fn(async () => undefined),
            closeFromGateway: jest.fn(async () => undefined),
        } as never,
        signingSecret: SECRET,
        toleranceSeconds: 300,
        logger: silentLogger,
    });

    return { service, webhooks, settle, fail };
}

function event(id: string, type = 'payment_intent.succeeded'): string {
    return JSON.stringify({
        id,
        type,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'pi_123', metadata: { paymentTransactionId: 'txn-1' } } },
    });
}

describe('handleStripe', () => {
    it('verifies, records and processes a genuine delivery', async () => {
        const { service, webhooks, settle } = build();
        const body = event('evt_1');

        const outcome = await service.handleStripe({
            rawBody: body,
            signatureHeader: sign(body),
        });

        expect(outcome).toEqual({ received: true, processed: true, eventId: 'evt_1' });
        expect(settle).toHaveBeenCalledTimes(1);
        expect(webhooks.markProcessed).toHaveBeenCalledWith('evt_1', expect.any(Date));
    });

    /**
     * The design document's requirement, stated exactly: *"If Stripe webhook
     * retried, webhook_id already exists → skipped (no duplicate charge)."*
     */
    it('skips a replay of an event id it has already seen', async () => {
        const { service, settle } = build();
        const body = event('evt_1');
        const header = sign(body);

        const first = await service.handleStripe({ rawBody: body, signatureHeader: header });
        const second = await service.handleStripe({ rawBody: body, signatureHeader: header });

        expect(first.processed).toBe(true);
        expect(second.processed).toBe(false);
        // The important assertion: the settlement ran ONCE.
        expect(settle).toHaveBeenCalledTimes(1);
    });

    /**
     * Verification happens before anything is written — storing an unverified
     * delivery would put attacker-controlled JSON in the replay queue.
     */
    it('rejects an unsigned delivery without recording it', async () => {
        const { service, webhooks } = build();
        const body = event('evt_forged');

        await expect(
            service.handleStripe({ rawBody: body, signatureHeader: undefined }),
        ).rejects.toThrow(/signature/i);

        expect(webhooks.record).not.toHaveBeenCalled();
        expect(webhooks.seen.size).toBe(0);
    });

    it('rejects a delivery signed with the wrong secret', async () => {
        const { service, webhooks } = build();
        const body = event('evt_forged');

        await expect(
            service.handleStripe({
                rawBody: body,
                signatureHeader: sign(body, 'whsec_wrong'),
            }),
        ).rejects.toThrow(/signature/i);
        expect(webhooks.seen.size).toBe(0);
    });

    /**
     * An event type this platform does not handle is a no-op, not an error:
     * an endpoint that 400s on unknown events is one the provider eventually
     * disables, taking the events that matter with it.
     */
    it('records and acknowledges an event type it does not handle', async () => {
        const { service, webhooks, settle } = build();
        const body = event('evt_other', 'invoice.created');

        const outcome = await service.handleStripe({
            rawBody: body,
            signatureHeader: sign(body),
        });

        expect(outcome.processed).toBe(true);
        expect(settle).not.toHaveBeenCalled();
        expect(webhooks.seen.has('evt_other')).toBe(true);
    });

    /**
     * A delivery that fails processing keeps its row, unprocessed, with the
     * error on it. Dropping it is how an order silently never gets paid.
     */
    it('keeps a failed delivery in the replay queue and rethrows', async () => {
        const { service, webhooks, settle } = build();
        settle.mockRejectedValueOnce(new Error('database unavailable') as never);
        const body = event('evt_fail');

        await expect(
            service.handleStripe({ rawBody: body, signatureHeader: sign(body) }),
        ).rejects.toThrow('database unavailable');

        expect(webhooks.seen.has('evt_fail')).toBe(true);
        expect(webhooks.markFailed).toHaveBeenCalledWith('evt_fail', 'database unavailable');
        expect(webhooks.markProcessed).not.toHaveBeenCalled();
    });

    it('refuses a payload with no event id', async () => {
        const { service } = build();
        const body = JSON.stringify({ type: 'payment_intent.succeeded' });

        await expect(
            service.handleStripe({ rawBody: body, signatureHeader: sign(body) }),
        ).rejects.toThrow(/event id/i);
    });
});
