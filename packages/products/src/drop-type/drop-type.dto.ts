import { z } from 'zod';
import { bool, int, optionalText } from '../dto/product.dto';
import {
    DIMENSION_CODE_RE,
    dropTypeRulesSchema,
    isValidVariantCodePattern,
    normalizeHex,
    TYPE_CODE_RE,
    VALUE_CODE_RE,
} from './rules';

/**
 * Request schemas for drop-type administration.
 *
 * Codes are normalised on the way in (type and value codes upper-cased) so a
 * client typing `t_shirt` or `blk` gets the canonical form rather than a 422.
 * See docs/admin/drop-types-and-variants.md §8.
 */

const typeCode = z.string().trim().toUpperCase().regex(TYPE_CODE_RE, 'Use A–Z, 0–9 and _, starting with a letter (e.g. T_SHIRT)');
const dimensionCode = z.string().trim().regex(DIMENSION_CODE_RE, 'Use camelCase letters and digits, starting lower-case (e.g. size, packSize)');
const valueCode = z.union([z.string(), z.number()])
    .transform((v) => String(v).trim().toUpperCase())
    .pipe(z.string().regex(VALUE_CODE_RE, 'Use 1–12 letters or digits (e.g. M, BLK, 10)'));

/** `#abc` / `AABBCC` / `#AABBCC` → `#AABBCC`; `""` / `null` → `null`. */
export const hexCode = z
    .union([z.string(), z.null()])
    .transform((value, ctx) => {
        const trimmed = value?.trim() ?? '';
        if (trimmed === '') return null;
        const hex = normalizeHex(trimmed);
        if (!hex) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a hex color such as #1A1A1A' });
            return z.NEVER;
        }
        return hex;
    });

const variantMode = z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(['NONE', 'OPTIONAL', 'REQUIRED']));

const displayType = z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(['TEXT', 'COLOR']));

const pattern = z
    .string()
    .trim()
    .max(64)
    .refine(isValidVariantCodePattern, 'Must contain both {groupCode} and {values}');

export const dimensionValueInputSchema = z
    .object({
        code: valueCode,
        label: z.string().trim().min(1).max(64),
        hexCode: hexCode.optional(),
        position: int({ min: 0 }).optional(),
    })
    .strict();
export type DimensionValueInput = z.infer<typeof dimensionValueInputSchema>;

export const dimensionInputSchema = z
    .object({
        code: dimensionCode,
        label: z.string().trim().min(1).max(64),
        required: bool.default(false),
        allowCustomValues: bool.default(false),
        displayType: displayType.default('TEXT'),
        position: int({ min: 0 }).optional(),
        values: z.array(dimensionValueInputSchema).max(100).default([]),
    })
    .strict()
    .refine((d) => new Set(d.values.map((v) => v.code)).size === d.values.length, {
        message: 'The same value code appears twice',
        path: ['values'],
    });
export type DimensionInput = z.infer<typeof dimensionInputSchema>;

/** POST /admin/drop-types */
export const createDropTypeSchema = z
    .object({
        code: typeCode,
        name: z.string().trim().min(1).max(64),
        description: optionalText(1000).optional(),
        variantMode,
        variantCodePattern: pattern.optional(),
        dimensions: z.array(dimensionInputSchema).max(10).default([]),
        rules: dropTypeRulesSchema.default([]),
    })
    .strict()
    .refine((t) => new Set(t.dimensions.map((d) => d.code)).size === t.dimensions.length, {
        message: 'The same dimension code appears twice',
        path: ['dimensions'],
    })
    .refine((t) => t.variantMode !== 'NONE' || t.dimensions.length === 0, {
        message: 'A NONE type has no variants, so it takes no dimensions',
        path: ['dimensions'],
    });
export type CreateDropTypeDto = z.infer<typeof createDropTypeSchema>;

/** PATCH /admin/drop-types/:code — `code` itself never changes. */
export const updateDropTypeSchema = z
    .object({
        name: z.string().trim().min(1).max(64),
        description: optionalText(1000),
        variantMode,
        variantCodePattern: pattern,
        rules: dropTypeRulesSchema,
        isActive: bool,
    })
    .partial()
    .strict();
export type UpdateDropTypeDto = z.infer<typeof updateDropTypeSchema>;

/** PATCH /admin/drop-types/:code/dimensions/:dimension */
export const updateDimensionSchema = z
    .object({
        label: z.string().trim().min(1).max(64),
        required: bool,
        allowCustomValues: bool,
        displayType,
        position: int({ min: 0 }),
    })
    .partial()
    .strict();
export type UpdateDimensionDto = z.infer<typeof updateDimensionSchema>;

/** PATCH /admin/drop-types/:code/dimensions/:dimension/values/:value */
export const updateDimensionValueSchema = z
    .object({
        label: z.string().trim().min(1).max(64),
        hexCode,
        position: int({ min: 0 }),
    })
    .partial()
    .strict();
export type UpdateDimensionValueDto = z.infer<typeof updateDimensionValueSchema>;

/** GET /admin/drop-types */
export const listDropTypesQuerySchema = z.object({
    includeInactive: bool.default(false),
});
