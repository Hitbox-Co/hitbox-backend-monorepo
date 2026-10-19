export const PAYMENTS_MODULE = 'payments' as const;

export const PAYMENTS_ERROR_CODES = {
    NOT_FOUND: 'PAYMENTS_NOT_FOUND',
    FORBIDDEN: 'PAYMENTS_FORBIDDEN',
    /** The drop is not buyable: not active, sold out, or age-gated. */
    NOT_PURCHASABLE: 'PAYMENTS_NOT_PURCHASABLE',
    /** No unreserved unit is left to hold. */
    OUT_OF_STOCK: 'PAYMENTS_OUT_OF_STOCK',
    /** No price is configured for the buyer's market. */
    NO_PRICE: 'PAYMENTS_NO_PRICE',
    /** The hold expired before payment settled. */
    RESERVATION_EXPIRED: 'PAYMENTS_RESERVATION_EXPIRED',
    /** Webhook signature missing, malformed, or wrong. */
    INVALID_SIGNATURE: 'PAYMENTS_INVALID_SIGNATURE',
    /** No gateway configuration is active for this scope. */
    NO_GATEWAY: 'PAYMENTS_NO_GATEWAY',
    /** The transition the caller asked for is not reachable from here. */
    INVALID_TRANSITION: 'PAYMENTS_INVALID_TRANSITION',
    /** A refund was asked for on an order that cannot be refunded. */
    NOT_REFUNDABLE: 'PAYMENTS_NOT_REFUNDABLE',
    /** Money cannot move until the physical item is back. */
    RETURN_NOT_CONFIRMED: 'PAYMENTS_RETURN_NOT_CONFIRMED',
    /** The refund amount exceeds what was actually captured. */
    AMOUNT_EXCEEDS_CAPTURE: 'PAYMENTS_AMOUNT_EXCEEDS_CAPTURE',
    /** No payment provider adapter is wired on this deployment. */
    GATEWAY_UNAVAILABLE: 'PAYMENTS_GATEWAY_UNAVAILABLE',
} as const;

// ── Capabilities (all already in the permission catalog) ────────────────────

/** Reading payments, refunds and disputes. */
export const PAYMENT_READ_CAPABILITY = 'payment-royalty:read' as const;
/** Gateway configuration — System Admin only in the role catalog. */
export const PAYMENT_CONFIGURE_CAPABILITY = 'payment-royalty:configure' as const;
/** Administering payments: reviewing a parked charge, resolving a dispute. */
export const PAYMENT_MANAGE_CAPABILITY = 'payment-royalty:manage' as const;
/** Approving and executing a refund. */
export const ORDER_REFUND_CAPABILITY = 'order:refund' as const;
/** Placing an order — the buyer's own capability. */
export const ORDER_CREATE_CAPABILITY = 'order:create' as const;

export const PAYMENTS_DEFAULT_LIMIT = 20;
export const PAYMENTS_MAX_LIMIT = 100;

/**
 * Quarantine applied to a returned unit whose tag came back damaged, missing
 * or tampered with — the design document's "NFC tag flagged against resale for
 * 90 days".
 */
export const RESALE_BLOCK_DAYS = 90;

export const PAYMENT_EVENTS = {
    /** A checkout produced an order and a pending charge. */
    CHECKOUT_STARTED: 'payments.checkout.started',
    /** The gateway confirmed the money arrived. */
    PAYMENT_SUCCEEDED: 'payments.payment.succeeded',
    PAYMENT_FAILED: 'payments.payment.failed',
    REFUND_REQUESTED: 'payments.refund.requested',
    REFUND_APPROVED: 'payments.refund.approved',
    REFUND_PROCESSED: 'payments.refund.processed',
    DISPUTE_OPENED: 'payments.dispute.opened',
    DISPUTE_RESOLVED: 'payments.dispute.resolved',
} as const;

/** Audit event types this module writes. Registered in @hitbox/audit. */
export const PAYMENTS_AUDIT_EVENTS = {
    GATEWAY_CONFIGURE: 'payment.gateway.configure',
    PAYMENT_SETTLE: 'payment.settle',
    ORDER_REFUND: 'order.refund',
    REFUND_PROCESS: 'refund.process',
    DISPUTE_OPEN: 'dispute.open',
    DISPUTE_RESOLVE: 'dispute.resolve',
} as const;

/**
 * Provider event names this module understands, mapped to what they mean here.
 * Anything not in this map is stored (so it is never lost) and acknowledged
 * with a 200 — a webhook endpoint that 400s on an event type it does not care
 * about is a webhook endpoint the provider eventually disables.
 */
export const STRIPE_EVENT_MAP: Record<string, string> = {
    'payment_intent.succeeded': 'PAYMENT_SUCCEEDED',
    'payment_intent.payment_failed': 'PAYMENT_FAILED',
    'charge.succeeded': 'PAYMENT_SUCCEEDED',
    'charge.failed': 'PAYMENT_FAILED',
    'charge.refunded': 'REFUND_SETTLED',
    'refund.updated': 'REFUND_SETTLED',
    'charge.dispute.created': 'DISPUTE_OPENED',
    'charge.dispute.closed': 'DISPUTE_CLOSED',
};
