import { PRODUCTS_ERROR_CODES } from '../constants/products.constant';
import type { VariantRepository } from '../variant/variant.repository';

/**
 * The answer other modules get when they ask "may this happen?" about a
 * drop's variants. `ok: false` carries an error code and message the caller
 * turns into its own AppError — products never throws across the port.
 */
export type VariantVerdict =
    | { ok: true }
    | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/**
 * Products' answer to two questions other modules ask through injected ports:
 *
 *  - @hitbox/skus, before minting:   may N units be minted with/without this variant?
 *  - @hitbox/releases, at submit:    does a REQUIRED-type drop have its variants?
 *
 * Satisfies `ISkuVariantPolicy` and `IReleaseVariantPolicy` structurally —
 * neither module imports this file. Wired in apps/backend/src/bootstrap.ts.
 *
 * Legacy drops (no type) always pass: rules only apply to typed drops.
 */
export class VariantPolicyAdapter {
    constructor(private readonly variants: VariantRepository) { }

    async checkMint(input: { productId: string; variantId: string | null; count: number }): Promise<VariantVerdict> {
        const drop = await this.variants.findForPolicy(input.productId);
        const mode = drop?.dropType?.variantMode ?? null;

        if (input.variantId === null) {
            if (mode === 'REQUIRED') {
                return {
                    ok: false,
                    code: PRODUCTS_ERROR_CODES.VARIANTS_REQUIRED,
                    message:
                        `Every unit of a ${drop!.dropType!.code} drop must belong to a variant — ` +
                        'pass the variantId to mint for.',
                };
            }
            return { ok: true };
        }

        if (mode === 'NONE') {
            return {
                ok: false,
                code: PRODUCTS_ERROR_CODES.VARIANTS_NOT_ALLOWED,
                message: `A ${drop!.dropType!.code} drop has no variants — mint without variantId.`,
            };
        }

        const variant = await this.variants.findVariantForMint(input.variantId);
        // Ownership is the skus module's own check (variantBelongsTo); only
        // the variant rules are answered here.
        if (!variant || variant.productId !== input.productId) return { ok: true };

        if (variant.archivedAt !== null || !variant.isActive) {
            return {
                ok: false,
                code: PRODUCTS_ERROR_CODES.VARIANT_INACTIVE,
                message: `Variant ${variant.variantCode} is ${variant.archivedAt ? 'archived' : 'inactive'}; units cannot be minted for it.`,
            };
        }
        if (variant.totalSupply !== null && variant._count.skus + input.count > variant.totalSupply) {
            return {
                ok: false,
                code: PRODUCTS_ERROR_CODES.VARIANT_SUPPLY_EXCEEDED,
                message:
                    `Variant ${variant.variantCode} is capped at ${variant.totalSupply} units and ` +
                    `${variant._count.skus} exist; ${input.count} more would exceed it.`,
                details: {
                    variantTotalSupply: variant.totalSupply,
                    minted: variant._count.skus,
                    requested: input.count,
                },
            };
        }
        return { ok: true };
    }

    async checkSubmittable(productId: string): Promise<VariantVerdict> {
        const drop = await this.variants.findForPolicy(productId);
        if (drop?.dropType?.variantMode !== 'REQUIRED') return { ok: true };
        if ((await this.variants.countActive(productId)) > 0) return { ok: true };
        return {
            ok: false,
            code: PRODUCTS_ERROR_CODES.VARIANTS_REQUIRED,
            message:
                `A ${drop.dropType.code} drop needs at least one active variant before it can be ` +
                'submitted for review. Add them with POST /admin/products/:id/variants/generate.',
        };
    }
}
