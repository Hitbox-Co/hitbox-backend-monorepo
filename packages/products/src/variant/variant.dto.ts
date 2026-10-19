import { z } from 'zod';
import { bool, int, optionalText } from '../dto/product.dto';
import { VARIANT_GENERATE_MAX } from '../constants/products.constant';

/**
 * Request schemas for a drop's variants.
 *
 * An option value is either a value code (`"M"`, or `10` as a number) or —
 * for a dimension that allows custom values — a full value object:
 * `{ "code": "SND", "label": "Sand", "hexCode": "#C2B280" }`.
 *
 * See docs/admin/drop-types-and-variants.md §8.
 */

const optionValue = z.union([
    z.union([z.string(), z.number()]).transform((v) => String(v)),
    z
        .object({
            code: z.union([z.string(), z.number()]).transform((v) => String(v)),
            label: z.string().trim().max(64).optional(),
            hexCode: z.string().trim().max(9).nullish(),
        })
        .strict(),
]);

const optionMap = z.record(z.string().trim().min(1), optionValue);

export const variantInputSchema = z
    .object({
        options: optionMap,
        /** Defaults to the value labels joined: "M / Black". */
        label: optionalText(120).optional(),
        position: int({ min: 0 }).optional(),
        /** Per-variant supply cap; omit to draw from the drop's totalSupply. */
        totalSupply: int({ min: 0 }).nullish(),
    })
    .strict();
export type VariantInput = z.infer<typeof variantInputSchema>;

/** POST /admin/products/:id/variants — explicit list, all-or-nothing. */
export const createVariantsSchema = z
    .object({ variants: z.array(variantInputSchema).min(1).max(VARIANT_GENERATE_MAX) })
    .strict();
export type CreateVariantsDto = z.infer<typeof createVariantsSchema>;

/** POST /admin/products/:id/variants/generate — every combination of the chosen values. */
export const generateVariantsSchema = z
    .object({
        /** `{ size: ["S","M"], color: ["BLK", { code: "SND", label: "Sand" }] }` */
        select: z.record(z.string().trim().min(1), z.array(optionValue).min(1).max(50)),
        /** Applied to every created variant. */
        totalSupplyEach: int({ min: 0 }).nullish(),
        /** Preview only — nothing is written. */
        dryRun: bool.default(false),
    })
    .strict()
    .refine((v) => Object.keys(v.select).length > 0, {
        message: 'Choose values for at least one dimension',
        path: ['select'],
    });
export type GenerateVariantsDto = z.infer<typeof generateVariantsSchema>;

/**
 * PATCH /admin/products/:id/variants/:variantId
 *
 * Options are deliberately absent: a variant's options are its identity, and
 * orders and units point at it. Archive it and create a new one instead.
 */
export const updateVariantSchema = z
    .object({
        label: z.string().trim().min(1).max(120),
        position: int({ min: 0 }),
        totalSupply: int({ min: 0 }).nullable(),
        isActive: bool,
    })
    .partial()
    .strict();
export type UpdateVariantDto = z.infer<typeof updateVariantSchema>;

/** GET /admin/products/:id/variants */
export const listVariantsQuerySchema = z.object({
    includeArchived: bool.default(false),
});
