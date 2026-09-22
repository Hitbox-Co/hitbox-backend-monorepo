import { ApprovalAuthority, ApprovalStatus, ComplianceStatus } from '@hitbox/database';
import { z } from 'zod';
import { RELEASES_DEFAULT_LIMIT, RELEASES_MAX_LIMIT } from '../constants/releases.constant';

export { ApprovalAuthority };

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
         * The approver's acceptance of the legal compliance terms.
         *
         * **Required, and required to be `true`, when approving.** Not a
         * formality: this is the record that a named person took
         * responsibility for the drop, and it is the reason a platform
         * administrator cannot approve on an owner's behalf. Rejecting needs
         * no acceptance — refusing to publish something carries no liability.
         *
         * Render it as an unticked checkbox showing
         * `LEGAL_COMPLIANCE_STATEMENT`; never default it to ticked.
         */
        acceptLegalCompliance: z.literal(true).optional(),
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
    )
    .refine(
        (value) =>
            value.status !== ApprovalStatus.APPROVED || value.acceptLegalCompliance === true,
        {
            message:
                'You must accept the legal compliance statement to approve this release.',
            path: ['acceptLegalCompliance'],
        },
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

/**
 * An administrator sending a decided review back for another decision.
 *
 * Creates version N+1 in PENDING with the same authority as the version it
 * came from, so the owner — not the administrator — decides again. The reason
 * is required: the owner is being asked to look at this a second time and is
 * owed an explanation, and it is the first thing they will read.
 */
export const reopenReleaseApprovalSchema = z
    .object({
        reason: z.string().trim().min(1).max(2000),
    })
    .strict();
export type ReopenReleaseApprovalDto = z.infer<typeof reopenReleaseApprovalSchema>;

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
    /** Who must sign this off: ARTIST, ORGANIZATION or PLATFORM. */
    authority: ApprovalAuthority;
    requiredArtistId: string | null;
    requiredArtistName: string | null;
    requiredOrganizationId: string | null;
    requiredOrganizationName: string | null;
    /** The approver's acceptance, and which wording they accepted. */
    legalComplianceAccepted: boolean;
    legalComplianceAcceptedAt: string | null;
    legalComplianceVersion: string | null;
    /** Set when an administrator sent this version back for another decision. */
    reopenedFromVersion: number | null;
    reopenedById: string | null;
    reopenedAt: string | null;
    reopenReason: string | null;
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
        /** The rejection note, when this version was rejected. */
        comment: string | null;
        complianceStatus: ComplianceStatus;
        authority: ApprovalAuthority;
        approverId: string;
        approverEmail: string | null;
        /** Who actually recorded the decision, which is not always the submitter. */
        checkedById: string | null;
        legalComplianceAccepted: boolean;
        legalComplianceVersion: string | null;
        reopenedFromVersion: number | null;
        reopenReason: string | null;
        decidedAt: string | null;
        createdAt: string;
    }[];
    /** Whether the caller may still act on this row, and why not if they cannot. */
    canDecide: boolean;
    blockedReason: string | null;
    /**
     * Split, because the two are genuinely different for an administrator
     * looking at a brand's drop: they may reject it and may not approve it.
     * Drive the two buttons from these, not from one flag.
     */
    canApprove: boolean;
    canReject: boolean;
    canReopen: boolean;
    approveBlockedReason: string | null;
    /** The wording the approver is being asked to accept. */
    legalComplianceStatement: string;
    legalComplianceVersionRequired: string;
}
