import { GatewayError } from '../domain/gateway-error';
import { toMinorUnits } from '../domain/minor-units';
import type {
    CreateChargeInput,
    CreateChargeResult,
    CreateRefundInput,
    CreateRefundResult,
    IPaymentGateway,
} from '../domain/interfaces/payment-gateway.interface';

/**
 * `IPaymentGateway` against Stripe's REST API.
 *
 * Plain `fetch` rather than the SDK: two endpoints, form-encoded, and the
 * whole surface this module uses fits on one screen — which also makes it
 * testable with a fake `fetch` and nothing else.
 *
 * The key is never held here. Every call resolves it from the configuration's
 * `credentialsRef` through `resolveSecretKey`, which the composition root
 * implements against whatever secret store the deployment has. A ref with no
 * key behind it is a `NOT_CONFIGURED` error at the moment it is used, not a
 * startup failure — a platform with one org on its own Stripe account should
 * not stop taking money because that org's key is missing.
 *
 * Retries are safe by construction: every request carries the caller's
 * idempotency key (`refund:<refundRequestId>`, the checkout key), so Stripe
 * returns the first result instead of moving money twice.
 */

export interface StripeGatewayDeps {
    resolveSecretKey: (credentialsRef: string) => string | undefined;
    fetch?: typeof fetch;
    apiBase?: string;
    /** Per request. Stripe's p99 is well under this. */
    timeoutMs?: number;
}

/** Stripe's refund `reason` is a closed list; anything else goes in metadata. */
function stripeRefundReason(reasonCode?: string): 'duplicate' | 'fraudulent' | 'requested_by_customer' {
    if (reasonCode === 'DUPLICATE_CHARGE') return 'duplicate';
    if (reasonCode === 'FRAUDULENT_CHARGE') return 'fraudulent';
    return 'requested_by_customer';
}

/** Stripe's bracket form encoding: `metadata[orderId]=…`. One level is all this needs. */
function encodeForm(params: Record<string, string | number | boolean | Record<string, string> | undefined>): string {
    const out = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (typeof value === 'object') {
            for (const [inner, innerValue] of Object.entries(value)) {
                // Stripe caps metadata values at 500 characters.
                out.append(`${key}[${inner}]`, innerValue.slice(0, 500));
            }
        } else {
            out.append(key, String(value));
        }
    }
    return out.toString();
}

export { toMinorUnits };

export function createStripeGateway(deps: StripeGatewayDeps): IPaymentGateway {
    const doFetch = deps.fetch ?? fetch;
    const apiBase = deps.apiBase ?? 'https://api.stripe.com';
    const timeoutMs = deps.timeoutMs ?? 20_000;

    async function post(
        path: string,
        credentialsRef: string,
        idempotencyKey: string,
        params: Parameters<typeof encodeForm>[0],
    ): Promise<Record<string, unknown>> {
        const key = deps.resolveSecretKey(credentialsRef);
        if (!key) {
            throw new GatewayError(
                'NOT_CONFIGURED',
                `no Stripe secret key is configured for "${credentialsRef}".`,
            );
        }

        let response: Response;
        try {
            response = await doFetch(`${apiBase}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Idempotency-Key': idempotencyKey,
                },
                body: encodeForm(params),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new GatewayError('UNREACHABLE', (error as Error).message);
        }

        const requestId = response.headers.get('request-id');
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) return body;

        const err = (body['error'] ?? {}) as Record<string, unknown>;
        const message = typeof err['message'] === 'string' ? err['message'] : `HTTP ${response.status}`;
        const providerCode = typeof err['code'] === 'string' ? err['code'] : null;
        // 429 and 5xx are Stripe's problem, and the idempotency key makes a
        // retry harmless. Everything else is an answer.
        const kind = response.status === 429 || response.status >= 500 ? 'UNREACHABLE' : 'REJECTED';
        throw new GatewayError(kind, message, { providerCode, requestId });
    }

    return {
        name: 'STRIPE',

        async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
            const intent = await post('/v1/payment_intents', input.credentialsRef, input.idempotencyKey, {
                amount: toMinorUnits(input.amount, input.currency),
                currency: input.currency.toLowerCase(),
                'automatic_payment_methods[enabled]': true,
                description: `HitBox order ${input.orderId}`,
                // paymentTransactionId is what the webhook matches on first.
                metadata: {
                    ...input.metadata,
                    orderId: input.orderId,
                    paymentTransactionId: input.paymentTransactionId,
                    buyerId: input.buyerId,
                },
            });
            return {
                gatewayRef: String(intent['id']),
                clientToken: typeof intent['client_secret'] === 'string' ? intent['client_secret'] : null,
                settled: intent['status'] === 'succeeded',
            };
        },

        async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
            const refund = await post('/v1/refunds', input.credentialsRef, input.idempotencyKey, {
                // A PaymentIntent (pi_…) or, for charges made outside it, a Charge (ch_…).
                ...(input.paymentGatewayRef.startsWith('ch_')
                    ? { charge: input.paymentGatewayRef }
                    : { payment_intent: input.paymentGatewayRef }),
                amount: toMinorUnits(input.amount, input.currency),
                reason: stripeRefundReason(input.reasonCode),
                metadata: {
                    ...input.metadata,
                    ...(input.reason ? { reason: input.reason } : {}),
                },
            });

            const status = refund['status'];
            if (status === 'failed' || status === 'canceled') {
                throw new GatewayError(
                    'REJECTED',
                    `the refund was ${status}${typeof refund['failure_reason'] === 'string' ? ` (${refund['failure_reason']})` : ''}.`,
                    { providerCode: typeof refund['failure_reason'] === 'string' ? refund['failure_reason'] : null },
                );
            }
            return { gatewayRefundId: String(refund['id']), settled: status === 'succeeded' };
        },
    };
}
