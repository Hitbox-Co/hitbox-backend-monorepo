import { ApprovalAuthority, ApprovalStatus } from '@hitbox/database';
import { resolveAuthority } from './approval-authority';
import type { ReleaseRepository } from '../repository/release.repository';

/**
 * Answers "has this drop cleared release?" for the two modules that need to
 * know: the catalog before it publishes a drop, and skus before it mints one's
 * edition.
 *
 * The provider side of a consumer-defined port. @hitbox/products and
 * @hitbox/skus each declare the shape they need, this implements it, and
 * bootstrap connects them. Neither consumer reads `ReleaseApproval`, and this
 * module imports neither of them — the only thing crossing the boundary is the
 * shape of an answer.
 *
 * ## The one rule, in both directions
 *
 * A drop is cleared when **its owner has approved it**, or when it has no
 * owner to ask. Everything else — never submitted, still pending, rejected —
 * is not cleared, and the reason says which.
 *
 * That single condition gates both publication and minting, and it should:
 * a rejected drop has no business being taken live, and no business having
 * serialized units created for it either. Units minted against a drop that
 * never ships are inventory somebody has to reconcile later.
 */
export class ReleaseGateAdapter {
    constructor(private readonly releases: ReleaseRepository) { }

    /**
     * Does a drop with this ownership need an approval at all?
     *
     * Pure and synchronous — no database read. Exposed so a caller that does
     * not yet HAVE a drop row (the catalog, mid-create) can ask the question
     * without keeping a second copy of the authority rule. `resolveAuthority`
     * stays the single source of truth.
     */
    requiresApproval(ownership: {
        artistId: string | null;
        organizationId: string | null;
    }): boolean {
        const { authority } = resolveAuthority({
            artistId: ownership.artistId,
            organizationId: ownership.organizationId,
            // Not needed to distinguish NONE from the rest: NONE is decided by
            // the absence of both owners, and the other branches only narrow
            // *which* owner decides, never whether one exists.
            organizationType: null,
            artistUserId: null,
        });
        return authority !== ApprovalAuthority.NONE;
    }

    async describeLatest(productId: string): Promise<{
        cleared: boolean;
        approvalRequired: boolean;
        reason: string | null;
        approvalId: string | null;
        version: number | null;
        status: string | null;
        authority: string | null;
    }> {
        const latest = await this.releases.findLatestForProduct(productId);

        // No review yet. Whether that is a problem depends entirely on whether
        // this drop has an owner whose consent is being waited on.
        if (!latest) {
            const ownership = await this.releases.findOwnership(productId);
            if (!ownership) {
                return {
                    cleared: false,
                    approvalRequired: true,
                    reason: 'This drop does not exist.',
                    approvalId: null,
                    version: null,
                    status: null,
                    authority: null,
                };
            }

            // No artist and no organization: nobody's consent to wait for, so
            // the drop is cleared from the moment it exists. This is what lets
            // an administrator mint HitBox's own edition without first walking
            // it through a review that would auto-pass anyway.
            if (!this.requiresApproval(ownership)) {
                return {
                    cleared: true,
                    approvalRequired: false,
                    reason: null,
                    approvalId: null,
                    version: null,
                    status: null,
                    authority: ApprovalAuthority.NONE,
                };
            }

            return {
                cleared: false,
                approvalRequired: true,
                reason:
                    'This drop has never been submitted for review. Submit it first, ' +
                    'so its owner can approve it.',
                approvalId: null,
                version: null,
                status: null,
                authority: null,
            };
        }

        const base = {
            approvalRequired: latest.authority !== ApprovalAuthority.NONE,
            approvalId: latest.id,
            version: latest.version,
            status: latest.status as string,
            authority: latest.authority as string,
        };

        switch (latest.status) {
            case ApprovalStatus.APPROVED:
                return { cleared: true, reason: null, ...base };

            case ApprovalStatus.REJECTED:
                return {
                    cleared: false,
                    reason:
                        `Review version ${latest.version} was rejected` +
                        (latest.comment ? `: "${latest.comment}"` : '.') +
                        ' Reopen it so its owner can decide again.',
                    ...base,
                };

            default:
                return {
                    cleared: false,
                    reason:
                        `Review version ${latest.version} is still awaiting a decision ` +
                        'from the party that owns this drop.',
                    ...base,
                };
        }
    }
}
