/**
 * Port: "may these units be minted, given the drop's variant rules?"
 *
 * Implemented by @hitbox/products (VariantPolicyAdapter), which owns drop
 * types and variants; wired in apps/backend/src/bootstrap.ts. This module
 * never imports products.
 *
 * The rules it answers (docs/admin/drop-types-and-variants.md §7.3):
 *  - a drop whose type REQUIRES variants cannot mint units without one;
 *  - a drop whose type has NO variants cannot mint units for one;
 *  - an archived or inactive variant cannot receive new units;
 *  - a variant with its own `totalSupply` cannot be minted past it.
 *
 * Optional: without it, minting behaves exactly as before drop types existed.
 */
export type SkuVariantVerdict =
    | { ok: true }
    | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export interface ISkuVariantPolicy {
    checkMint(input: { productId: string; variantId: string | null; count: number }): Promise<SkuVariantVerdict>;
}
