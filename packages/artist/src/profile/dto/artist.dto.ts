import { z } from 'zod';
import {
    ARTISTS_DEFAULT_LIMIT,
    ARTISTS_MAX_LIMIT,
} from '../constants/artist-profile.constant';

export const listArtistsQuerySchema = z.object({
    /** Matches name or slug, case-insensitively. */
    search: z.string().trim().min(1).max(100).optional(),
    /** Narrow to one brand's roster — how the drop form filters after a brand is picked. */
    organizationId: z.string().uuid().optional(),
    isActive: z.coerce.boolean().optional(),
    /** Public-profile flag. Unrelated to `isActive`: an artist can be live and unlisted. */
    isPublic: z.coerce.boolean().optional(),
    /** Omit to list live artists only. */
    includeArchived: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(ARTISTS_MAX_LIMIT)
        .default(ARTISTS_DEFAULT_LIMIT),
});
export type ListArtistsQuery = z.infer<typeof listArtistsQuerySchema>;

/**
 * One option in an artist picker.
 *
 * `organizationId` / `organizationName` are included because an artist alone
 * is ambiguous on a form that also asks for a brand: picking artist "Kaze"
 * under brand "Lumen Studios" is a different drop from "Kaze" under their own
 * artist-individual org, and the API cannot tell which was meant.
 */
export interface ArtistResponse {
    id: string;
    name: string;
    slug: string;
    genre: string | null;
    avatarUrl: string | null;
    isPublic: boolean;
    isActive: boolean;
    archivedAt: string | null;
    organizationId: string | null;
    organizationName: string | null;
    counts: { products: number; collections: number };
}
