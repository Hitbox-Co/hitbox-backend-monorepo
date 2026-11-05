import { z } from 'zod';

/**
 * Request schemas for /api/v1/artist/drops/:dropId/content.
 * docs/content/drop-content.md §3.
 *
 * The content rules (serial numbers within 1…totalSupply, one regular tier
 * per drop, file types and sizes) are the content module's and are checked
 * there; these schemas are the HTTP shape. File uploads reuse the collection
 * reward schemas — same files, same rules.
 */

const optionalText = (max: number) =>
    z
        .union([z.string(), z.null()])
        .transform((value) => {
            const trimmed = value?.trim() ?? '';
            return trimmed === '' ? null : trimmed;
        })
        .pipe(z.string().max(max).nullable());

const booleanish = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/** Serial numbers ("#001" is 1). The content module checks them against the drop's supply. */
const serialNumbers = z.array(z.number().int().positive()).max(1000);

/** POST …/content */
export const createDropContentSchema = z
    .object({
        /** REGULAR: every owner of the drop. EXCLUSIVE: only the owners of `serialNumbers`. */
        tier: z.enum(['REGULAR', 'EXCLUSIVE']),
        name: z.string().trim().min(1).max(120),
        description: optionalText(2000).optional(),
        /** Default `true`. `false` keeps it hidden while you add files. */
        isActive: booleanish.optional(),
        /** EXCLUSIVE only, required: the units that open it. */
        serialNumbers: serialNumbers.optional(),
    })
    .strict();
export type CreateDropContentDto = z.infer<typeof createDropContentSchema>;

/** PATCH …/content/:bundleId — any subset. `serialNumbers` replaces the whole list. */
export const updateDropContentSchema = z
    .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: optionalText(2000).optional(),
        isActive: booleanish.optional(),
        serialNumbers: serialNumbers.min(1).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one field to change.' });
export type UpdateDropContentDto = z.infer<typeof updateDropContentSchema>;
