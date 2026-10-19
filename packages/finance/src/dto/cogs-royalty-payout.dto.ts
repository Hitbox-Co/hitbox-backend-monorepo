import { z } from 'zod';

/**
 * DTOs for the three 2026-09-15 changes: COGS + sales price entry, the
 * artist-level royalty rate, and quarterly payout decisions. Kept apart from
 * `finance.dto.ts` so the older file is untouched. Money is a string in and
 * out, same rule as there.
 */

const positiveMoney = z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Must be an amount with at most 2 decimal places.');

const percentage = z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Must be a percentage, e.g. "15" or "12.500".')
    .refine((value) => Number(value) > 0 && Number(value) <= 100, 'Must be above 0 and at most 100.');

/** Reasons are mandatory on every payout decision; short ones are noise. */
export const decisionReason = z
    .string()
    .trim()
    .min(5, 'A reason of at least 5 characters is required.')
    .max(1000);

// ── Drop pricing ────────────────────────────────────────────────────────────

/**
 * COGS and both prices arrive together or not at all. There is deliberately
 * no PATCH shape: a change is a new version carrying a `varianceReason`.
 */
export const createDropPricingSchema = z
    .object({
        /** Unit cost in USD. */
        costOfGoods: positiveMoney,
        /** Unit cost in INR: entered with the rest, never on its own. */
        costOfGoodsInr: positiveMoney,
        salesPriceUsd: positiveMoney,
        salesPriceInr: positiveMoney,
        costSource: z.string().trim().min(1).max(200).optional(),
        /** Required when this supersedes an existing version. */
        varianceReason: z.string().trim().min(5).max(1000).optional(),
        /** Defaults to now. Future dates are rejected: one active version at a time. */
        effectiveFrom: z.coerce.date().optional(),
    })
    .strict();
export type CreateDropPricingDto = z.infer<typeof createDropPricingSchema>;

export interface DropPricingView {
    id: string;
    publicCode: string | null;
    dropId: string;
    version: number;
    costOfGoods: string;
    costOfGoodsInr: string;
    salesPriceUsd: string;
    salesPriceInr: string;
    grossProfitUsd: string | null;
    grossProfitInr: string | null;
    status: string;
    isActive: boolean;
    effectiveFrom: string;
    effectiveTo: string | null;
    costSource: string | null;
    varianceReason: string | null;
    approvedById: string | null;
    approvedAt: string | null;
    createdAt: string;
}

// ── Artist royalty rate ─────────────────────────────────────────────────────

/** `basis` and scope are not accepted: artist-level and NET_PROFIT only. */
export const setArtistRoyaltyRateSchema = z
    .object({
        percentage,
        effectiveFrom: z.coerce.date().optional(),
        payoutThreshold: positiveMoney.optional(),
    })
    .strict();
export type SetArtistRoyaltyRateDto = z.infer<typeof setArtistRoyaltyRateSchema>;

export interface ArtistRoyaltyRateView {
    ruleId: string;
    artistId: string;
    basis: string;
    percentage: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    isInForce: boolean;
}

// ── Payout decisions ────────────────────────────────────────────────────────

/** Accepts the spec's `approvalReason` as an alias of `reason`. */
export const approveWithReasonSchema = z
    .object({ reason: decisionReason.optional(), approvalReason: decisionReason.optional() })
    .transform((value, ctx) => {
        const reason = value.reason ?? value.approvalReason;
        if (!reason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reason'],
                message: 'A reason of at least 5 characters is required.',
            });
            return z.NEVER;
        }
        return { reason };
    });
export type ApproveWithReasonDto = z.infer<typeof approveWithReasonSchema>;

export const rejectPayoutSchema = approveWithReasonSchema;
export type RejectPayoutDto = ApproveWithReasonDto;

export const transferPayoutSchema = z
    .object({
        /** The provider's payout object id, for reconciliation. */
        gatewayPayoutRef: z.string().trim().min(1).max(200),
        paidAt: z.coerce.date().optional(),
    })
    .strict();
export type TransferPayoutDto = z.infer<typeof transferPayoutSchema>;

export const quarterlySweepSchema = z
    .object({
        /** Sweeps as if run at this instant (resolves to that quarter boundary). Defaults to now. */
        asOf: z.coerce.date().optional(),
        dryRun: z.boolean().default(false),
    })
    .strict();
export type QuarterlySweepDto = z.infer<typeof quarterlySweepSchema>;
