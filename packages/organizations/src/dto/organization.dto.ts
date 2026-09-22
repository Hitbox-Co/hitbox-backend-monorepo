import { OrganizationType } from '@hitbox/database';
import { z } from 'zod';
import {
    ORGANIZATIONS_DEFAULT_LIMIT,
    ORGANIZATIONS_MAX_LIMIT,
} from '../constants/organizations.constant';

export const listOrganizationsQuerySchema = z.object({
    /** Matches name or slug, case-insensitively. */
    search: z.string().trim().min(1).max(100).optional(),
    /** `HITBOX` | `BRAND` | `ARTIST_INDIVIDUAL`. Case-insensitive. */
    type: z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(z.nativeEnum(OrganizationType))
        .optional(),
    isActive: z.coerce.boolean().optional(),
    /** Omit to list live organizations only. */
    includeArchived: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(ORGANIZATIONS_MAX_LIMIT)
        .default(ORGANIZATIONS_DEFAULT_LIMIT),
});
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;

/**
 * One option in a brand picker.
 *
 * `type` is part of the shape rather than a detail because the picker is
 * otherwise ambiguous: "Kaze" as an `ARTIST_INDIVIDUAL` org and "Kaze" as an
 * `Artist` record are different rows with different ids, and choosing the
 * wrong one files the drop under the wrong owner.
 */
export interface OrganizationResponse {
    id: string;
    name: string;
    type: OrganizationType;
    slug: string;
    isActive: boolean;
    archivedAt: string | null;
    /** Live reference counts — useful for "safe to retire?" and for sorting. */
    counts: { artists: number; products: number };
}

export { OrganizationType };
