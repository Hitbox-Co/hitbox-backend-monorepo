import { ApprovalStatus, ComplianceStatus } from '@hitbox/database';
import { z } from 'zod';
import { RELEASES_DEFAULT_LIMIT, RELEASES_MAX_LIMIT } from '../constants/releases.constant';

export const listReleaseApprovalsQuerySchema = z.object({
    status: z.nativeEnum(ApprovalStatus).optional(),
    complianceStatus: z.nativeEnum(ComplianceStatus).optional(),
    productId: z.string().uuid().optional(),
    approverId: z.string().uuid().optional(),
    /** `true` returns only the newest version per product — the review queue. */
    latestOnly: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(RELEASES_MAX_LIMIT).default(RELEASES_DEFAULT_LIMIT),
});
export type ListReleaseApprovalsQuery = z.infer<typeof listReleaseApprovalsQuerySchema>;

/**
 * Recording a decision.
 *
 * `comment` is required for a rejection: a drop bounced back with no reason
 * costs the submitter a round trip to find out what to fix, and the approval
 * row is the only place that answer can live.
 */
export const decideReleaseApprovalSchema = z
    .object({
        status: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED]),
        comment: z.string().trim().max(2000).optional(),
        /**
         * The compliance sign-off. Defaults to CLEARED on an approval and
         * FLAGGED on a rejection, but a reviewer may clear a drop's compliance
         * while still rejecting it on other grounds.
         */
        complianceStatus: z.nativeEnum(ComplianceStatus).optional(),
        /** Pointer to the published odds disclosure — required for randomised drops. */
        oddsDisclosureRef: z.string().trim().max(500).optional(),
    })
    .strict()
    .refine(
        (value) => value.status !== ApprovalStatus.REJECTED || Boolean(value.comment),
        { message: 'A comment is required when rejecting a release.', path: ['comment'] },
    );
export type DecideReleaseApprovalDto = z.infer<typeof decideReleaseApprovalSchema>;

/**
 * Amending an approval that has **not** been decided yet — the reviewer
 * editing their compliance notes before committing. Once `decidedAt` is set,
 * this is refused and reversal needs the override capability.
 */
export const updateReleaseApprovalSchema = z
    .object({
        comment: z.string().trim().max(2000).nullable().optional(),
        complianceStatus: z.nativeEnum(ComplianceStatus).optional(),
        oddsDisclosureRef: z.string().trim().max(500).nullable().optional(),
    })
    .strict();
export type UpdateReleaseApprovalDto = z.infer<typeof updateReleaseApprovalSchema>;

/** Opening a review on a product — creates version N+1. */
export const submitForReviewSchema = z
    .object({
        productId: z.string().uuid(),
        comment: z.string().trim().max(2000).optional(),
    })
    .strict();
export type SubmitForReviewDto = z.infer<typeof submitForReviewSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export interface ReleaseApprovalListItem {
    id: string;
    productId: string;
    status: ApprovalStatus;
    version: number;
    comment: string | null;
    complianceStatus: ComplianceStatus;
    oddsDisclosureRef: string | null;
    approverId: string;
    approverEmail: string | null;
    approverName: string | null;
    checkedById: string | null;
    checkedAt: string | null;
    decidedAt: string | null;
    createdAt: string;
    updatedAt: string;
    product: {
        id: string;
        groupCode: string;
        name: string;
        status: string;
        complianceStatus: ComplianceStatus;
        /** The three fields the approver is accountable for. Surface them prominently. */
        isAgeSpecific: boolean;
        minimumAge: number | null;
        oddsDisclosureRef: string | null;
        totalSupply: number;
        organizationId: string | null;
        artistId: string | null;
    };
}

export interface ReleaseApprovalDetail extends ReleaseApprovalListItem {
    /** Every prior decision on this product, newest first — the review trail. */
    history: {
        id: string;
        version: number;
        status: ApprovalStatus;
        comment: string | null;
        complianceStatus: ComplianceStatus;
        approverId: string;
        approverEmail: string | null;
        decidedAt: string | null;
        createdAt: string;
    }[];
    /** Whether the caller may still act on this row, and why not if they cannot. */
    canDecide: boolean;
    blockedReason: string | null;
}
