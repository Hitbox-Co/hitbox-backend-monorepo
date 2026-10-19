import { z } from 'zod';
import {
    ARTIST_BIO_MAX,
    ARTIST_NAME_MAX,
    ARTIST_SLUG_MAX,
    ARTIST_SLUG_MIN,
    ARTIST_SLUG_RE,
} from '../constants/artist-self.constant';

/**
 * Request schemas for `/api/v1/artist/me`.
 *
 * `.strict()` on the profile update is load-bearing: fields an artist may NOT
 * change (organizationId, userId, isActive, compliance…) are refused with a
 * 422 naming the field, instead of being silently dropped — a client that
 * thinks it changed something it cannot must be told.
 */

/** `""` and `null` both clear an optional text field. */
const clearableText = (max: number) =>
    z
        .union([z.string(), z.null()])
        .transform((value) => {
            const trimmed = value?.trim() ?? '';
            return trimmed === '' ? null : trimmed;
        })
        .pipe(z.string().max(max).nullable());

const booleanish = z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

/** PATCH /artist/me — every field optional; send only what changes. */
export const updateMyProfileSchema = z
    .object({
        name: z.string().trim().min(1).max(ARTIST_NAME_MAX),
        /** Public URL handle. Lower-cased for you. */
        slug: z
            .string()
            .trim()
            .toLowerCase()
            .min(ARTIST_SLUG_MIN)
            .max(ARTIST_SLUG_MAX)
            .regex(ARTIST_SLUG_RE, 'Use lowercase letters, digits and single hyphens (e.g. the-midnight-club)'),
        bio: clearableText(ARTIST_BIO_MAX),
        /** A code or label from GET /artist/genres; `null` clears it. Validated in the service. */
        genre: z.union([z.string().trim().min(1).max(64), z.null()]),
        /** Whether the profile is listed publicly on the storefront. */
        isPublic: booleanish,
    })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: 'Send at least one field to change',
    });
export type UpdateMyProfileDto = z.infer<typeof updateMyProfileSchema>;

/** POST /artist/me/{avatar|cover}/upload-url */
export const imageUploadRequestSchema = z
    .object({
        fileName: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().min(1).max(255),
        /** Exact file size in bytes (browsers: `file.size`). Max 15 MB. */
        sizeBytes: z.coerce.number().int().positive(),
    })
    .strict();
export type ImageUploadRequestDto = z.infer<typeof imageUploadRequestSchema>;

/** PUT /artist/me/{avatar|cover} — after the file has been PUT to S3. */
export const setImageSchema = z.object({ assetId: z.string().uuid() }).strict();
export type SetImageDto = z.infer<typeof setImageSchema>;

/** Which profile image a request is about. */
export type ArtistImageKind = 'avatar' | 'cover';
