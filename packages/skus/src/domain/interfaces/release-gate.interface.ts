/**
 * "Has this drop cleared release?" — asked by skus, answered by releases.
 *
 * A consumer-defined port. This module owns `Sku` and therefore owns minting,
 * but it does not own `ReleaseApproval` and must not read that table.
 *
 * ## Why minting has to ask
 *
 * A serialized unit is a claim about a physical object: it gets a code, a
 * serial within an edition, and eventually a chip and an owner. Creating those
 * for a drop the artist has not approved — and may yet reject — produces
 * inventory that refers to nothing anybody will ever ship, and which somebody
 * then has to reconcile away by hand.
 *
 * So minting waits for the same clearance publication waits for: **the owner
 * has approved it, or there is no owner to ask.** A drop naming neither an
 * artist nor an organization is HitBox's own and is mintable immediately.
 *
 * See docs/admin/drop-approval-lifecycle.md.
 */

export interface SkuReleaseVerdict {
    /** True when the owner has approved the drop, or there is none to ask. */
    cleared: boolean;
    /** False when the drop needs no approval at all. */
    approvalRequired: boolean;
    /** Why not, phrased for the person reading it on screen. Null when allowed. */
    reason: string | null;
    approvalId: string | null;
    version: number | null;
    status: string | null;
    authority: string | null;
}

export interface ISkuReleaseGate {
    describeLatest(productId: string): Promise<SkuReleaseVerdict>;
}
