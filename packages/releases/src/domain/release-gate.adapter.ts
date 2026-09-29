import { ApprovalStatus } from '@hitbox/database';
import type { ReleaseRepository } from '../repository/release.repository';

/**
 * Answers the catalog's "has this drop cleared review?" question.
 *
 * The provider side of a consumer-defined port: @hitbox/products declares
 * `IReleaseGate`, this implements it, and bootstrap connects the two. Products
 * never reads `ReleaseApproval`, and releases never imports products — the only
 * thing crossing the boundary is the shape of an answer.
 *
 * Structurally typed on purpose: the return shape matches `ReleaseGateVerdict`
 * without this module importing it, which is what keeps the dependency
 * one-directional.
 */
export class ReleaseGateAdapter {
    constructor(private readonly releases: ReleaseRepository) { }

    async describeLatest(productId: string): Promise<{
        publishable: boolean;
        reason: string | null;
        approvalId: string | null;
        version: number | null;
        status: string | null;
        authority: string | null;
    }> {
        const latest = await this.releases.findLatestForProduct(productId);

        // No review at all. Refused rather than waved through: a drop that was
        // never submitted has nobody's sign-off, and the auto-pass for unowned
        // drops still writes a row — so "no row" genuinely means "never
        // reviewed", not "did not need reviewing".
        if (!latest) {
            return {
                publishable: false,
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
            approvalId: latest.id,
            version: latest.version,
            status: latest.status as string,
            authority: latest.authority as string,
        };

        switch (latest.status) {
            case ApprovalStatus.APPROVED:
                return { publishable: true, reason: null, ...base };

            case ApprovalStatus.REJECTED:
                return {
                    publishable: false,
                    reason:
                        `Review version ${latest.version} was rejected` +
                        (latest.comment ? `: "${latest.comment}"` : '.') +
                        ' Reopen it so its owner can decide again.',
                    ...base,
                };

            default:
                return {
                    publishable: false,
                    reason:
                        `Review version ${latest.version} is still awaiting a decision ` +
                        'from the party that owns this drop.',
                    ...base,
                };
        }
    }
}
