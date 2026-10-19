/**
 * Port: "is this drop's variant setup complete enough to be reviewed?"
 *
 * Implemented by @hitbox/products (VariantPolicyAdapter); wired in
 * apps/backend/src/bootstrap.ts. A drop whose type REQUIRES variants must have
 * at least one active variant before it is submitted, because the owner
 * approves the drop together with its variants.
 *
 * Optional: without it, submission behaves exactly as before drop types existed.
 */
export type ReleaseVariantVerdict =
    | { ok: true }
    | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export interface IReleaseVariantPolicy {
    checkSubmittable(productId: string): Promise<ReleaseVariantVerdict>;
}
