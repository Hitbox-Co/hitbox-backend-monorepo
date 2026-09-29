/**
 * "Has this drop cleared review?" — asked by products, answered by releases.
 *
 * A consumer-defined port. The catalog owns `Drop` and therefore owns the act
 * of publishing it, but it does **not** own `ReleaseApproval` and must not read
 * that table. It asks this question instead, and @hitbox/releases answers it.
 *
 * ## Why publishing needs to ask at all
 *
 * The approval lifecycle exists to capture the drop owner's consent — an
 * artist signing their own drop off, a brand signing off theirs. That
 * guarantee is only worth something if the *last* step before a drop goes live
 * checks it. Otherwise publishing is a side door around the whole rule, and
 * the approval becomes advisory.
 *
 * See docs/admin/drop-approval-lifecycle.md.
 */

export interface ReleaseGateVerdict {
    /** True when the latest review permits publication. */
    publishable: boolean;
    /** Why not, phrased for the person reading it on screen. Null when allowed. */
    reason: string | null;
    /** The review this verdict was read from, for the audit trail. */
    approvalId: string | null;
    version: number | null;
    /** `PENDING` | `APPROVED` | `REJECTED`, or null when no review exists. */
    status: string | null;
    /** `ARTIST` | `ORGANIZATION` | `PLATFORM` | `NONE`, or null. */
    authority: string | null;
}

export interface IReleaseGate {
    /**
     * The publication verdict for a drop, from its most recent review.
     *
     * Reads the **latest version only**. An older APPROVED version does not
     * license publication when a newer one was rejected or is still open —
     * the current answer is the one that counts.
     */
    describeLatest(productId: string): Promise<ReleaseGateVerdict>;
}
