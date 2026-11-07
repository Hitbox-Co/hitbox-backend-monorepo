import { z } from 'zod';

/**
 * Request schemas for /api/v1/artist/collections/:collectionId/reward.
 * docs/content/collection-rewards.md §3.
 *
 * The reward rules themselves (which file types, how many, how big) are the
 * content module's and are checked there; these schemas are the HTTP shape.
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

/** PUT …/reward — create it, edit it, or restore a removed one. */
export const saveRewardSchema = z
    .object({
        name: z.string().trim().min(1).max(120),
        description: optionalText(2000).optional(),
        /** Default `true` on create. `false` pauses it: nobody new unlocks it, nobody opens it. */
        isActive: booleanish.optional(),
    })
    .strict();
export type SaveRewardDto = z.infer<typeof saveRewardSchema>;

/** POST …/reward/items/upload-url */
export const rewardUploadSchema = z
    .object({
        fileName: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().min(1).max(255),
        /** Exact size in bytes (browsers: `file.size`). */
        sizeBytes: z.coerce.number().int().positive(),
    })
    .strict();
export type RewardUploadDto = z.infer<typeof rewardUploadSchema>;

/** POST …/reward/items — after the file was PUT to the upload URL. */
export const addRewardItemSchema = z
    .object({
        assetId: z.string().uuid(),
        title: optionalText(200).optional(),
    })
    .strict();
export type AddRewardItemDto = z.infer<typeof addRewardItemSchema>;

/** PATCH …/reward/items/:itemId */
export const updateRewardItemSchema = z
    .object({
        /** `null` / `""` falls back to the file name. */
        title: optionalText(200),
    })
    .strict();
export type UpdateRewardItemDto = z.infer<typeof updateRewardItemSchema>;

/** PUT …/reward/items/order — every item, each once, in the new order. */
export const reorderRewardItemsSchema = z
    .object({
        itemIds: z.array(z.string().uuid()).min(1).max(20),
    })
    .strict();
export type ReorderRewardItemsDto = z.infer<typeof reorderRewardItemsSchema>;
