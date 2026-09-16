/**
 * The payment provider, as this module needs it.
 *
 * Deliberately tiny, and deliberately optional. Nothing in HitBox's own
 * records depends on a provider SDK being present: a deployment with no
 * adapter wired still takes checkouts (the order and the pending charge are
 * recorded), still ingests webhooks (that is how settlement is confirmed), and
 * still runs the whole refund workflow — it just cannot *initiate* a charge or
 * a refund against the provider from the server, so those steps are completed
 * by the provider's own hosted flow and confirmed by webhook.
 *
 * That shape is not a compromise, it is how card payments work: the
 * authoritative statement that money moved is the webhook, never the response
 * to the request that started it. Treating the adapter as optional keeps the
 * code honest about which of the two this system believes.
 */

export interface CreateChargeInput {
    orderId: string;
    paymentTransactionId: string;
    amount: string;
    currency: string;
    idempotencyKey: string;
    buyerId: string;
    /** Pointer into the secrets manager, from PaymentGatewayConfig. */
    credentialsRef: string;
    metadata?: Record<string, string>;
}

export interface CreateChargeResult {
    /** The provider's id for the charge/intent, stored as `gatewayRef`. */
    gatewayRef: string;
    /**
     * Whatever the client needs to complete the payment (a Stripe client
     * secret, a Razorpay order id). Opaque to this module.
     */
    clientToken: string | null;
    /** True only if the provider settled synchronously. Usually false. */
    settled: boolean;
}

export interface CreateRefundInput {
    paymentGatewayRef: string;
    amount: string;
    currency: string;
    idempotencyKey: string;
    credentialsRef: string;
    reason?: string;
}

export interface CreateRefundResult {
    gatewayRefundId: string;
    /** True if the provider confirmed the refund synchronously. */
    settled: boolean;
}

export interface IPaymentGateway {
    readonly name: 'STRIPE';
    createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
    createRefund(input: CreateRefundInput): Promise<CreateRefundResult>;
}
