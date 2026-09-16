import { z } from 'zod';
import { PAYMENTS_DEFAULT_LIMIT, PAYMENTS_MAX_LIMIT } from '../constants/payments.constant';

/** Money crosses the wire as a string, in and out. See finance's DTO note. */
const money = z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Must be an amount with at most 2 decimal places.');

const uuid = z.string().uuid();

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(PAYMENTS_MAX_LIMIT).default(PAYMENTS_DEFAULT_LIMIT),
};

// ── Checkout ────────────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
    productId: uuid,
    variantId: uuid.optional(),
    marketId: uuid.optional(),
    /**
     * Capped at 1, deliberately. Every unit is serialized and an `Order`
     * carries exactly one `skuId`, so "2 of #14" is not a thing that exists —
     * a genuine multi-unit basket needs order lines, which this schema does
     * not have. Refusing it here is honest; silently reserving two units
     * against one order id would not be.
     */
    quantity: z.coerce.number().int().min(1).max(1).default(1),
    /**
     * Required, and required to be `true`. The drop's terms are the evidence
     * HitBox has in a dispute, and `Order.termsAcceptedAt` is only meaningful
     * if it cannot be set without the buyer actually saying yes.
     */
    termsAccepted: z.literal(true),
    shippingAddressId: uuid.optional(),
    billingAddressId: uuid.optional(),
    /** Chosen provider. Only STRIPE exists today; the column is an enum. */
    gateway: z.enum(['STRIPE']).default('STRIPE'),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

// ── Payment transactions ────────────────────────────────────────────────────

export const listPaymentsQuerySchema = z.object({
    ...pagination,
    orderId: uuid.optional(),
    status: z
        .enum(['INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW'])
        .optional(),
    gateway: z.enum(['STRIPE']).optional(),
    needsReview: z
        .union([z.literal('true'), z.literal('false')])
        .transform((value) => value === 'true')
        .optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const reviewPaymentSchema = z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().min(1).max(500),
});
export type ReviewPaymentDto = z.infer<typeof reviewPaymentSchema>;

// ── Gateway configuration ───────────────────────────────────────────────────

export const createGatewayConfigSchema = z
    .object({
        scope: z.enum(['PLATFORM', 'ORGANIZATION', 'DROP']),
        organizationId: uuid.optional(),
        gateway: z.enum(['STRIPE']),
        isDefault: z.boolean().default(false),
        /**
         * A pointer into the secrets manager, never a key. Rejected if it
         * looks like an actual credential — a `sk_live_…` in this column is a
         * secret in a database backup, and the mistake is easy enough to make
         * that it is worth refusing outright.
         */
        credentialsRef: z
            .string()
            .min(1)
            .max(200)
            .refine(
                (value) => !/^(sk_|rk_|pk_live|whsec_)/.test(value),
                'This looks like an API key. Store the key in the secrets manager and put its reference here.',
            ),
        status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
    })
    .refine((dto) => dto.scope !== 'ORGANIZATION' || Boolean(dto.organizationId), {
        message: 'An organization-scoped configuration must name its organization.',
        path: ['organizationId'],
    });
export type CreateGatewayConfigDto = z.infer<typeof createGatewayConfigSchema>;

export const updateGatewayConfigSchema = z.object({
    isDefault: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    credentialsRef: z.string().min(1).max(200).optional(),
});
export type UpdateGatewayConfigDto = z.infer<typeof updateGatewayConfigSchema>;

export const listGatewayConfigsQuerySchema = z.object({
    ...pagination,
    scope: z.enum(['PLATFORM', 'ORGANIZATION', 'DROP']).optional(),
    organizationId: uuid.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export type ListGatewayConfigsQuery = z.infer<typeof listGatewayConfigsQuerySchema>;

// ── Refunds ─────────────────────────────────────────────────────────────────

export const requestRefundSchema = z.object({
    orderId: uuid,
    reasonCode: z.enum([
        'DEFECTIVE_ITEM',
        'DEFECTIVE_TAG',
        'NOT_AS_DESCRIBED',
        'NOT_DELIVERED',
        'DUPLICATE_CHARGE',
        'BUYER_CHANGED_MIND',
        'FRAUDULENT_CHARGE',
        'OTHER',
    ]),
    reason: z.string().min(1).max(1000),
    /** Defaults to the order's full amount. */
    amount: money.optional(),
    /** Digital-only orders skip the AWAITING_RETURN hold. */
    physicalReturnRequired: z.boolean().default(true),
});
export type RequestRefundDto = z.infer<typeof requestRefundSchema>;

export const confirmReturnSchema = z.object({
    nfcTagCondition: z.enum(['INTACT', 'DAMAGED', 'MISSING', 'TAMPERED']),
    note: z.string().max(1000).optional(),
    receivedAt: z.coerce.date().optional(),
});
export type ConfirmReturnDto = z.infer<typeof confirmReturnSchema>;

export const approveRefundSchema = z.object({
    note: z.string().max(1000).optional(),
    /**
     * Approve without the item back. Requires an explicit override and a
     * reason: it is a real decision (a lost shipment, a goodwill refund), and
     * it should be visible as one in the audit trail rather than indistinguish-
     * able from a normal approval.
     */
    overridePhysicalReturn: z.boolean().default(false),
    overrideReason: z.string().max(500).optional(),
}).refine(
    (dto) => !dto.overridePhysicalReturn || Boolean(dto.overrideReason),
    { message: 'Overriding the physical-return requirement needs a reason.', path: ['overrideReason'] },
);
export type ApproveRefundDto = z.infer<typeof approveRefundSchema>;

export const rejectRefundSchema = z.object({
    rejectionReason: z.string().min(1).max(1000),
});
export type RejectRefundDto = z.infer<typeof rejectRefundSchema>;

export const processRefundSchema = z.object({
    /**
     * The provider's refund id. Supplied by the operator on a deployment with
     * no gateway adapter wired, filled in by the adapter otherwise.
     */
    gatewayRefundId: z.string().min(1).max(200).optional(),
    processedAt: z.coerce.date().optional(),
});
export type ProcessRefundDto = z.infer<typeof processRefundSchema>;

export const listRefundsQuerySchema = z.object({
    ...pagination,
    orderId: uuid.optional(),
    status: z
        .enum(['REQUESTED', 'AWAITING_RETURN', 'APPROVED', 'PROCESSED', 'REJECTED'])
        .optional(),
    reasonCode: z
        .enum([
            'DEFECTIVE_ITEM',
            'DEFECTIVE_TAG',
            'NOT_AS_DESCRIBED',
            'NOT_DELIVERED',
            'DUPLICATE_CHARGE',
            'BUYER_CHANGED_MIND',
            'FRAUDULENT_CHARGE',
            'OTHER',
        ])
        .optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;

// ── Disputes ────────────────────────────────────────────────────────────────

export const openDisputeSchema = z.object({
    orderId: uuid,
    paymentTransactionId: uuid.optional(),
    gateway: z.enum(['STRIPE']).default('STRIPE'),
    gatewayCaseRef: z.string().min(1).max(200).optional(),
    reasonCode: z.enum([
        'FRAUDULENT',
        'PRODUCT_NOT_RECEIVED',
        'PRODUCT_UNACCEPTABLE',
        'DUPLICATE',
        'SUBSCRIPTION_CANCELED',
        'CREDIT_NOT_PROCESSED',
        'UNRECOGNIZED',
        'OTHER',
    ]),
    reason: z.string().max(1000).optional(),
    amount: money,
    currency: z.enum(['USD', 'INR', 'GBP']),
    feeAmount: money.optional(),
    evidenceDueBy: z.coerce.date().optional(),
});
export type OpenDisputeDto = z.infer<typeof openDisputeSchema>;

export const submitEvidenceSchema = z.object({
    evidence: z.record(z.unknown()),
    note: z.string().max(1000).optional(),
});
export type SubmitEvidenceDto = z.infer<typeof submitEvidenceSchema>;

export const resolveDisputeSchema = z.object({
    outcome: z.enum(['WON', 'LOST', 'ACCEPTED', 'WITHDRAWN']),
    resolutionNote: z.string().min(1).max(1000),
    /** The fee the network kept regardless of outcome, if any. */
    feeAmount: money.optional(),
});
export type ResolveDisputeDto = z.infer<typeof resolveDisputeSchema>;

export const listDisputesQuerySchema = z.object({
    ...pagination,
    orderId: uuid.optional(),
    status: z
        .enum([
            'OPEN',
            'UNDER_REVIEW',
            'EVIDENCE_SUBMITTED',
            'WON',
            'LOST',
            'ACCEPTED',
            'WITHDRAWN',
        ])
        .optional(),
    /** Cases whose evidence deadline falls before this — the "act now" queue. */
    dueBefore: z.coerce.date().optional(),
});
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;

// ── Webhooks ────────────────────────────────────────────────────────────────

export const listWebhookEventsQuerySchema = z.object({
    ...pagination,
    provider: z.enum(['STRIPE']).optional(),
    eventType: z.string().max(100).optional(),
    /** Deliveries that failed processing — the replay queue. */
    unprocessedOnly: z
        .union([z.literal('true'), z.literal('false')])
        .transform((value) => value === 'true')
        .optional(),
});
export type ListWebhookEventsQuery = z.infer<typeof listWebhookEventsQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export interface CheckoutView {
    orderId: string;
    paymentTransactionId: string;
    skuId: string;
    reservationId: string;
    reservationExpiresAt: string;
    amount: string;
    currency: string;
    gateway: string;
    status: string;
    /** Opaque token the client completes the payment with; null with no adapter. */
    clientToken: string | null;
    gatewayRef: string | null;
}

export interface PaymentTransactionView {
    id: string;
    orderId: string;
    gateway: string;
    gatewayRef: string | null;
    status: string;
    amount: string;
    currency: string;
    needsReview: boolean;
    reviewedById: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
    failureReason: string | null;
    settledAt: string | null;
    createdAt: string;
}

export interface GatewayConfigView {
    id: string;
    scope: string;
    organizationId: string | null;
    gateway: string;
    isDefault: boolean;
    /** Never the credential itself — see the DTO's refusal above. */
    credentialsRef: string;
    status: string;
    createdAt: string;
    updatedAt: string;
}

export interface RefundView {
    id: string;
    orderId: string;
    requestedById: string;
    reason: string;
    reasonCode: string;
    status: string;
    amount: string;
    currency: string;
    physicalReturnRequired: boolean;
    physicalReturnConfirmedAt: string | null;
    nfcTagCondition: string | null;
    approvedById: string | null;
    approvedAt: string | null;
    rejectionReason: string | null;
    gatewayRefundId: string | null;
    processedAt: string | null;
    claimRevokedAt: string | null;
    resaleBlockedUntil: string | null;
    createdAt: string;
    /** What this request may do next, so the UI enables the right buttons. */
    allowedTransitions: string[];
}

export interface DisputeView {
    id: string;
    orderId: string;
    paymentTransactionId: string | null;
    gateway: string;
    gatewayCaseRef: string | null;
    reasonCode: string;
    reason: string | null;
    status: string;
    amount: string;
    currency: string;
    feeAmount: string | null;
    evidenceDueBy: string | null;
    evidenceSubmittedAt: string | null;
    resolvedById: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
    openedAt: string;
}

export interface WebhookEventView {
    id: string;
    provider: string;
    eventType: string;
    signatureVerified: boolean;
    processedAt: string | null;
    processingError: string | null;
    receivedAt: string;
}
