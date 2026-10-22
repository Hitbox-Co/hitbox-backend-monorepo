import { AppError } from '@hitbox/shared';
import { createStripeGateway, toMinorUnits } from '../src/adapters/stripe-gateway';
import { GatewayError, gatewayFailure } from '../src/domain/gateway-error';

/** docs/finance/stripe-adapter.md — the Stripe adapter. */

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status, headers });
    }) as unknown as typeof fetch;
    return { fn, calls };
}

const keys: Record<string, string> = { 'secrets://stripe/platform': 'sk_test_abc' };
const refundInput = {
    paymentGatewayRef: 'pi_123',
    amount: '2499.00',
    currency: 'INR',
    idempotencyKey: 'refund:r1',
    credentialsRef: 'secrets://stripe/platform',
    reason: 'Print peeling',
    reasonCode: 'DUPLICATE_CHARGE',
    metadata: { refundRequestId: 'r1', orderId: 'o1' },
};

const form = (call: Call) => new URLSearchParams(String(call.init.body));

describe('toMinorUnits', () => {
    it.each([
        ['2499.00', 'INR', 249900],
        ['29', 'GBP', 2900],
        ['0.29', 'USD', 29],
        ['19.9', 'USD', 1990],
        ['500', 'JPY', 500],
    ])('%s %s → %d', (amount, currency, expected) => {
        expect(toMinorUnits(amount, currency)).toBe(expected);
    });

    it('rejects anything that is not a plain amount', () => {
        expect(() => toMinorUnits('1e3', 'USD')).toThrow();
        expect(() => toMinorUnits('10.999', 'USD')).toThrow();
        expect(() => toMinorUnits('5.50', 'JPY')).toThrow();
    });
});

describe('createStripeGateway — refunds', () => {
    it('posts the refund with the key, idempotency key, minor units and metadata', async () => {
        const { fn, calls } = fakeFetch(200, { id: 're_1', status: 'succeeded' });
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });

        await expect(gateway.createRefund(refundInput)).resolves.toEqual({ gatewayRefundId: 're_1', settled: true });

        const call = calls[0]!;
        expect(call.url).toBe('https://api.stripe.com/v1/refunds');
        const headers = call.init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer sk_test_abc');
        expect(headers['Idempotency-Key']).toBe('refund:r1');
        const body = form(call);
        expect(body.get('payment_intent')).toBe('pi_123');
        expect(body.get('amount')).toBe('249900');
        expect(body.get('reason')).toBe('duplicate');
        expect(body.get('metadata[refundRequestId]')).toBe('r1');
        expect(body.get('metadata[reason]')).toBe('Print peeling');
    });

    it('refunds a ch_ reference as a charge, and reports a pending refund as unsettled', async () => {
        const { fn, calls } = fakeFetch(200, { id: 're_2', status: 'pending' });
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });

        const result = await gateway.createRefund({ ...refundInput, paymentGatewayRef: 'ch_9', reasonCode: 'OTHER' });
        expect(result).toEqual({ gatewayRefundId: 're_2', settled: false });
        expect(form(calls[0]!).get('charge')).toBe('ch_9');
        expect(form(calls[0]!).get('reason')).toBe('requested_by_customer');
    });

    it('a missing key is NOT_CONFIGURED, and nothing is sent', async () => {
        const { fn, calls } = fakeFetch(200, {});
        const gateway = createStripeGateway({ resolveSecretKey: () => undefined, fetch: fn });

        await expect(gateway.createRefund(refundInput)).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
        expect(calls).toHaveLength(0);
    });

    it('a 4xx is REJECTED, with Stripe’s message and code', async () => {
        const { fn } = fakeFetch(
            400,
            { error: { message: 'Charge pi_123 has already been refunded.', code: 'charge_already_refunded' } },
            { 'request-id': 'req_1' },
        );
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });

        await expect(gateway.createRefund(refundInput)).rejects.toMatchObject({
            kind: 'REJECTED',
            message: 'Charge pi_123 has already been refunded.',
            details: { providerCode: 'charge_already_refunded', requestId: 'req_1' },
        });
    });

    it.each([429, 500, 503])('a %d is UNREACHABLE (retryable)', async (status) => {
        const { fn } = fakeFetch(status, { error: { message: 'busy' } });
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });
        await expect(gateway.createRefund(refundInput)).rejects.toMatchObject({ kind: 'UNREACHABLE' });
    });

    it('a network failure is UNREACHABLE', async () => {
        const fn = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });
        await expect(gateway.createRefund(refundInput)).rejects.toMatchObject({ kind: 'UNREACHABLE' });
    });

    it('a refund Stripe created but immediately failed is REJECTED', async () => {
        const { fn } = fakeFetch(200, { id: 're_3', status: 'failed', failure_reason: 'expired_or_canceled_card' });
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });
        await expect(gateway.createRefund(refundInput)).rejects.toMatchObject({
            kind: 'REJECTED',
            details: { providerCode: 'expired_or_canceled_card' },
        });
    });
});

describe('createStripeGateway — charges', () => {
    it('creates a PaymentIntent carrying paymentTransactionId for the webhook', async () => {
        const { fn, calls } = fakeFetch(200, { id: 'pi_9', client_secret: 'pi_9_secret_x', status: 'requires_payment_method' });
        const gateway = createStripeGateway({ resolveSecretKey: (r) => keys[r], fetch: fn });

        const result = await gateway.createCharge({
            orderId: 'o1',
            paymentTransactionId: 't1',
            amount: '30.00',
            currency: 'USD',
            idempotencyKey: 'order:o1:attempt:1',
            buyerId: 'u1',
            credentialsRef: 'secrets://stripe/platform',
        });

        expect(result).toEqual({ gatewayRef: 'pi_9', clientToken: 'pi_9_secret_x', settled: false });
        const body = form(calls[0]!);
        expect(calls[0]!.url).toBe('https://api.stripe.com/v1/payment_intents');
        expect(body.get('amount')).toBe('3000');
        expect(body.get('currency')).toBe('usd');
        expect(body.get('metadata[paymentTransactionId]')).toBe('t1');
    });
});

describe('gatewayFailure', () => {
    it.each([
        ['NOT_CONFIGURED', 'PAYMENTS_GATEWAY_UNAVAILABLE'],
        ['REJECTED', 'PAYMENTS_GATEWAY_REJECTED'],
        ['UNREACHABLE', 'PAYMENTS_GATEWAY_UNREACHABLE'],
    ] as const)('%s → 400 %s', (kind, code) => {
        try {
            gatewayFailure(new GatewayError(kind, 'x'), 'issue this refund');
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect(error).toMatchObject({ code, statusCode: 400 });
            return;
        }
        throw new Error('expected a throw');
    });

    it('rethrows anything that is not a gateway error', () => {
        const bug = new TypeError('bug');
        expect(() => gatewayFailure(bug, 'x')).toThrow(bug);
    });
});
