import { z } from 'zod';
import { FINANCE_DEFAULT_LIMIT, FINANCE_MAX_LIMIT } from '../constants/finance.constant';

/**
 * Input validation and response shapes.
 *
 * Every monetary value crosses the wire as a **string**, in and out. A royalty
 * of 11.25 sent as a JSON number is a float by the time it reaches the client,
 * and a client that adds two of them gets 22.499999999999996. The database
 * column is DECIMAL(12,2) and the transport should not be lossier than the
 * storage.
 */

const money = z
    .string()
    .regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Must be an amount with at most 2 decimal places.');

const percentage = z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Must be a percentage, e.g. "15" or "12.500".')
    .refine((value) => Number(value) <= 100, 'Must not exceed 100.');

const uuid = z.string().uuid();

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(FINANCE_MAX_LIMIT).default(FINANCE_DEFAULT_LIMIT),
};

// ── Royalty rules ───────────────────────────────────────────────────────────

export const createRoyaltyRuleSchema = z
    .object({
        organizationId: uuid.optional(),
        artistId: uuid.optional(),
        collectionId: uuid.optional(),
        productId: uuid.optional(),
        basis: z.enum(['NET_PROFIT', 'GROSS_REVENUE']),
        splitType: z.string().min(1).max(50).default('SINGLE'),
        percentage: percentage.optional(),
        /** Multi-party deals. See `splitsOf` for the accepted shape. */
        splits: z
            .array(
                z.object({
                    payeeType: z.enum(['ARTIST', 'ORGANIZATION']),
                    artistId: uuid.optional(),
                    organizationId: uuid.optional(),
                    percentage,
                }),
            )
            .optional(),
        payoutThreshold: money.optional(),
        payoutFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY']).optional(),
        effectiveFrom: z.coerce.date().optional(),
        effectiveTo: z.coerce.date().optional(),
    })
    // A rule scoped to nothing at all is the platform-wide default, which is a
    // real thing to want but not one to create by forgetting a field.
    .refine(
        (dto) =>
            Boolean(dto.organizationId ?? dto.artistId ?? dto.collectionId ?? dto.productId),
        {
            message:
                'A rule must be scoped to a product, collection, artist or organization.',
            path: ['artistId'],
        },
    )
    .refine((dto) => Boolean(dto.percentage) || (dto.splits?.length ?? 0) > 0, {
        message: 'Provide either a percentage or at least one split.',
        path: ['percentage'],
    })
    .refine(
        (dto) =>
            !dto.effectiveTo ||
            !dto.effectiveFrom ||
            dto.effectiveTo.getTime() > dto.effectiveFrom.getTime(),
        { message: 'effectiveTo must be after effectiveFrom.', path: ['effectiveTo'] },
    );
export type CreateRoyaltyRuleDto = z.infer<typeof createRoyaltyRuleSchema>;

/**
 * Closing a rule is the only edit it accepts. A rule that has already priced
 * an accrual cannot change its terms retroactively — you close it and create
 * its successor, which is what keeps an old order reproducible.
 */
export const closeRoyaltyRuleSchema = z.object({
    effectiveTo: z.coerce.date(),
    reason: z.string().min(1).max(500),
});
export type CloseRoyaltyRuleDto = z.infer<typeof closeRoyaltyRuleSchema>;

export const listRoyaltyRulesQuerySchema = z.object({
    ...pagination,
    organizationId: uuid.optional(),
    artistId: uuid.optional(),
    collectionId: uuid.optional(),
    productId: uuid.optional(),
    /** Only rules in force at this moment. Defaults to all. */
    activeAt: z.coerce.date().optional(),
});
export type ListRoyaltyRulesQuery = z.infer<typeof listRoyaltyRulesQuerySchema>;

// ── Royalty ledger ──────────────────────────────────────────────────────────

export const listRoyaltyEntriesQuerySchema = z.object({
    ...pagination,
    status: z.enum(['ACCRUED', 'PENDING_PAYOUT', 'PAID', 'REVERSED']).optional(),
    entryType: z.enum(['ORIGINAL', 'ADJUSTMENT']).optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
    artistId: uuid.optional(),
    organizationId: uuid.optional(),
    orderId: uuid.optional(),
    payoutId: uuid.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type ListRoyaltyEntriesQuery = z.infer<typeof listRoyaltyEntriesQuerySchema>;

export const reverseRoyaltyEntrySchema = z.object({
    reasonCode: z
        .enum([
            'REFUND_REVERSAL',
            'DISPUTE_LOSS',
            'CALCULATION_ERROR',
            'RULE_CORRECTION',
            'MANUAL_CORRECTION',
        ])
        .default('MANUAL_CORRECTION'),
    reason: z.string().min(1).max(500),
});
export type ReverseRoyaltyEntryDto = z.infer<typeof reverseRoyaltyEntrySchema>;

// ── Payouts ─────────────────────────────────────────────────────────────────

export const listPayoutsQuerySchema = z.object({
    ...pagination,
    status: z.enum(['SCHEDULED', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED']).optional(),
    artistId: uuid.optional(),
    organizationId: uuid.optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
});
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuerySchema>;

/**
 * The threshold sweep. With no body it runs every payee at their own rule's
 * threshold; `artistId`/`organizationId` narrow it, and `thresholdOverride`
 * lets finance pay out a balance that has not reached the bar yet (an artist
 * closing their account, say) — deliberately explicit, never a default.
 */
export const schedulePayoutsSchema = z.object({
    artistId: uuid.optional(),
    organizationId: uuid.optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
    thresholdOverride: money.optional(),
    /** Preview only: compute the batches without writing anything. */
    dryRun: z.boolean().default(false),
});
export type SchedulePayoutsDto = z.infer<typeof schedulePayoutsSchema>;

export const approvePayoutSchema = z.object({
    note: z.string().max(500).optional(),
});
export type ApprovePayoutDto = z.infer<typeof approvePayoutSchema>;

export const executePayoutSchema = z.object({
    /** The provider's payout object id, for reconciliation. */
    gatewayPayoutRef: z.string().min(1).max(200),
    paidAt: z.coerce.date().optional(),
});
export type ExecutePayoutDto = z.infer<typeof executePayoutSchema>;

export const failPayoutSchema = z.object({
    failureReason: z.string().min(1).max(500),
});
export type FailPayoutDto = z.infer<typeof failPayoutSchema>;

// ── Adjustments ─────────────────────────────────────────────────────────────

export const createAdjustmentSchema = z.object({
    targetType: z.enum([
        'ROYALTY_LEDGER_ENTRY',
        'FINANCE_LEDGER_ENTRY',
        'ORDER',
        'PAYMENT_TRANSACTION',
        'ROYALTY_PAYOUT',
    ]),
    targetId: uuid,
    orderId: uuid.optional(),
    /** Signed: "-11.25" reverses, "5.00" posts a make-good. */
    amountAdjustment: money,
    currency: z.enum(['USD', 'INR', 'GBP']),
    reasonCode: z.enum([
        'REFUND_REVERSAL',
        'DISPUTE_LOSS',
        'CHARGEBACK_FEE',
        'CALCULATION_ERROR',
        'RULE_CORRECTION',
        'GOODWILL',
        'MANUAL_CORRECTION',
    ]),
    reason: z.string().min(1).max(500),
    metadata: z.record(z.unknown()).optional(),
});
export type CreateAdjustmentDto = z.infer<typeof createAdjustmentSchema>;

export const listAdjustmentsQuerySchema = z.object({
    ...pagination,
    targetType: z
        .enum([
            'ROYALTY_LEDGER_ENTRY',
            'FINANCE_LEDGER_ENTRY',
            'ORDER',
            'PAYMENT_TRANSACTION',
            'ROYALTY_PAYOUT',
        ])
        .optional(),
    targetId: uuid.optional(),
    orderId: uuid.optional(),
    reasonCode: z
        .enum([
            'REFUND_REVERSAL',
            'DISPUTE_LOSS',
            'CHARGEBACK_FEE',
            'CALCULATION_ERROR',
            'RULE_CORRECTION',
            'GOODWILL',
            'MANUAL_CORRECTION',
        ])
        .optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type ListAdjustmentsQuery = z.infer<typeof listAdjustmentsQuerySchema>;

// ── Platform ledger & reporting ─────────────────────────────────────────────

export const listFinanceEntriesQuerySchema = z.object({
    ...pagination,
    orderId: uuid.optional(),
    category: z
        .enum([
            'SALE_REVENUE',
            'COST_OF_GOODS',
            'GATEWAY_FEE',
            'REFUND',
            'CHARGEBACK',
            'ROYALTY_EXPENSE',
            'ROYALTY_PAYOUT',
            'ADJUSTMENT',
        ])
        .optional(),
    direction: z.enum(['CREDIT', 'DEBIT']).optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type ListFinanceEntriesQuery = z.infer<typeof listFinanceEntriesQuerySchema>;

export const revenueSummaryQuerySchema = z.object({
    organizationId: uuid.optional(),
    currency: z.enum(['USD', 'INR', 'GBP']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});
export type RevenueSummaryQuery = z.infer<typeof revenueSummaryQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export interface RoyaltyRuleView {
    id: string;
    scope: {
        organizationId: string | null;
        artistId: string | null;
        collectionId: string | null;
        productId: string | null;
    };
    basis: string;
    splitType: string;
    percentage: string | null;
    splitConfig: unknown;
    payoutThreshold: string | null;
    payoutFrequency: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    isInForce: boolean;
    createdAt: string;
}

export interface RoyaltyEntryView {
    id: string;
    orderId: string;
    ruleId: string;
    skuId: string | null;
    claimId: string | null;
    payee: {
        type: string;
        artistId: string | null;
        organizationId: string | null;
        name: string | null;
    };
    calculation: {
        basis: string;
        percentage: string | null;
        grossRevenue: string | null;
        costOfGoods: string | null;
        netProfit: string | null;
    };
    amount: string;
    currency: string;
    entryType: string;
    status: string;
    adjustsEntryId: string | null;
    payoutId: string | null;
    accruedAt: string;
    paidAt: string | null;
    createdAt: string;
}

export interface RoyaltyBalanceView {
    payeeType: string;
    payeeId: string | null;
    payeeName: string | null;
    currency: string;
    accrued: string;
    pendingPayout: string;
    paid: string;
    reversed: string;
    /** accrued + pendingPayout — what is owed but not yet in the bank. */
    outstanding: string;
    entryCount: number;
    /** The threshold in force, and whether `accrued` has reached it. */
    threshold: string;
    thresholdMet: boolean;
}

export interface PayoutView {
    id: string;
    payee: {
        type: string;
        artistId: string | null;
        organizationId: string | null;
        name: string | null;
    };
    amount: string;
    currency: string;
    entryCount: number;
    thresholdApplied: string | null;
    status: string;
    scheduledAt: string;
    approvedById: string | null;
    approvedAt: string | null;
    gatewayPayoutRef: string | null;
    paidAt: string | null;
    failureReason: string | null;
}

export interface AdjustmentView {
    id: string;
    targetType: string;
    targetId: string;
    orderId: string | null;
    amountAdjustment: string;
    currency: string;
    reasonCode: string;
    reason: string;
    actorId: string | null;
    refundRequestId: string | null;
    disputeCaseId: string | null;
    resultingEntryId: string | null;
    createdAt: string;
}

export interface FinanceEntryView {
    id: string;
    orderId: string | null;
    entryType: string;
    direction: string;
    category: string;
    amount: string;
    currency: string;
    costOfGoods: string | null;
    gatewayFee: string | null;
    description: string | null;
    createdAt: string;
}

export interface RevenueSummaryView {
    currency: string;
    grossRevenue: string;
    costOfGoods: string;
    gatewayFees: string;
    refunds: string;
    chargebacks: string;
    royaltyExpense: string;
    /** gross − cogs − fees − refunds − chargebacks − royalties. */
    netMargin: string;
    orderCount: number;
}
