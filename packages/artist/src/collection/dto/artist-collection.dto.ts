import { z } from 'zod';
import {
    ARTIST_SLUG_MAX,
    ARTIST_SLUG_MIN,
    ARTIST_SLUG_RE,
} from '../../self/constants/artist-self.constant';
import {
    COLLECTION_DEFAULT_LIMIT,
    COLLECTION_DESCRIPTION_MAX,
    COLLECTION_MAX_LIMIT,
    COLLECTION_NAME_MAX,
    MAX_DROPS_PER_ADD,
    MAX_LIVE_COLLECTIONS_PER_ARTIST,
} from '../constants/artist-collection.constant';

/**
 * Request schemas for artist collections.
 *
 * `.strict()` on create and update, as on `/artist/me`: fields an artist may
 * not set — `artistId`, `organizationId`, `position`, `isActive`,
 * `heroImageUrl` — are refused with a 422 naming the field rather than being
 * silently dropped. Ownership comes from the session, order from the reorder
 * route, and the hero image from the upload flow.
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

const slug = z
    .string()
    .trim()
    .toLowerCase()
    .min(ARTIST_SLUG_MIN)
    .max(ARTIST_SLUG_MAX)
    .regex(ARTIST_SLUG_RE, 'Use lowercase letters, digits and single hyphens (e.g. kaze-season-two)');

const uuid = z.string().uuid();

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(COLLECTION_MAX_LIMIT).default(COLLECTION_DEFAULT_LIMIT),
};

/** POST /artist/collections */
export const createCollectionSchema = z
    .object({
        name: z.string().trim().min(1).max(COLLECTION_NAME_MAX),
        /** Optional — derived as `{artist-slug}-{name}` when omitted. */
        slug: slug.optional(),
        description: clearableText(COLLECTION_DESCRIPTION_MAX).optional(),
        /**
         * Default `false`: a new collection is a draft until the artist
         * publishes it, so a half-filled series never shows on the storefront.
         */
        isPublic: booleanish.default(false),
    })
    .strict();
export type CreateCollectionDto = z.infer<typeof createCollectionSchema>;

/** PATCH /artist/collections/:collectionId — send only what changes. */
export const updateCollectionSchema = z
    .object({
        name: z.string().trim().min(1).max(COLLECTION_NAME_MAX),
        /** Changing it breaks old links — the name can change without it. */
        slug,
        description: clearableText(COLLECTION_DESCRIPTION_MAX),
        isPublic: booleanish,
    })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: 'Send at least one field to change',
    });
export type UpdateCollectionDto = z.infer<typeof updateCollectionSchema>;

/** PUT /artist/collections/order — every live collection, in display order. */
export const reorderCollectionsSchema = z
    .object({
        collectionIds: z
            .array(uuid)
            .min(1)
            .max(MAX_LIVE_COLLECTIONS_PER_ARTIST)
            .refine((ids) => new Set(ids).size === ids.length, 'A collection is listed twice.'),
    })
    .strict();
export type ReorderCollectionsDto = z.infer<typeof reorderCollectionsSchema>;

/**
 * POST /artist/collections/:collectionId/restore — body optional. Send a new
 * `name` when the old one has since been reused by another live collection.
 */
export const restoreCollectionSchema = z
    .object({ name: z.string().trim().min(1).max(COLLECTION_NAME_MAX).optional() })
    .strict();
export type RestoreCollectionDto = z.infer<typeof restoreCollectionSchema>;

/** GET /artist/collections */
export const listMyCollectionsQuerySchema = z.object({
    /** `live` (default) hides archived collections. */
    status: z.enum(['live', 'archived', 'all']).default('live'),
});
export type ListMyCollectionsQuery = z.infer<typeof listMyCollectionsQuerySchema>;

/**
 * GET /artist/collections/:collectionId/available-drops — what the "Add
 * drops" picker lists: the caller's own active drops not already in this
 * collection.
 */
export const availableDropsQuerySchema = z.object({
    ...pagination,
    /**
     * `false` (default): only drops in no collection at all. `true`: also
     * drops in your *other* collections — adding one moves it (send
     * `move: true`).
     */
    includeFiled: z.enum(['true', 'false']).transform((v) => v === 'true').default('false'),
    /** Case-insensitive match on name, or a group code. */
    q: z.string().trim().min(1).max(120).optional(),
});
export type AvailableDropsQuery = z.infer<typeof availableDropsQuerySchema>;

/** POST /artist/collections/:collectionId/drops */
export const addDropsSchema = z
    .object({
        dropIds: z
            .array(uuid)
            .min(1)
            .max(MAX_DROPS_PER_ADD, `At most ${MAX_DROPS_PER_ADD} drops per request.`)
            .refine((ids) => new Set(ids).size === ids.length, 'A drop is listed twice.'),
        /**
         * Allow taking drops out of another of your collections. Without it,
         * a drop that is already filed elsewhere is refused rather than moved
         * silently.
         */
        move: z.boolean().default(false),
    })
    .strict();
export type AddDropsDto = z.infer<typeof addDropsSchema>;

/** GET /admin/artist-collections — the monitoring list. */
export const adminListCollectionsQuerySchema = z.object({
    ...pagination,
    status: z.enum(['live', 'archived', 'all']).default('all'),
    artistId: uuid.optional(),
    organizationId: uuid.optional(),
    isPublic: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    /** Collections with no live drops — abandoned or not started. */
    empty: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    /** Case-insensitive match on name or slug. */
    q: z.string().trim().min(1).max(120).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    sort: z.enum(['newest', 'oldest', 'updated', 'name']).default('newest'),
});
export type AdminListCollectionsQuery = z.infer<typeof adminListCollectionsQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export interface CollectionView {
    id: string;
    publicCode: string | null;
    name: string;
    slug: string;
    description: string | null;
    heroImageUrl: string | null;
    /** 0-based display order on the artist's page, among live collections. */
    position: number;
    isPublic: boolean;
    isActive: boolean;
    archivedAt: string | null;
    /** `LIVE` or `ARCHIVED`. */
    status: 'LIVE' | 'ARCHIVED';
    counts: {
        /** Every drop ever filed under it, retired ones included. */
        drops: number;
        /**
         * Drops not archived, in any status (draft, in review, on sale…) —
         * the ones that block deleting the collection.
         */
        liveDrops: number;
        /**
         * Drops the artist is shown: status ACTIVE, switched on, not archived,
         * and by this collection's own artist.
         */
        activeDrops: number;
    };
    createdAt: string;
    updatedAt: string;
}

/** The artist's view adds what they may do right now. */
export interface MyCollectionView extends CollectionView {
    actions: {
        canEdit: boolean;
        canArchive: boolean;
        archiveBlockedReason: 'HAS_DROPS' | 'ARCHIVED' | null;
        /** True for an archived collection — `POST …/restore`. */
        canRestore: boolean;
    };
}

/** A drop as the artist sees it inside their collection. */
export interface ArtistDropView {
    id: string;
    publicCode: string | null;
    name: string;
    groupCode: string;
    totalSupply: number;
    publishedAt: string | null;
    releaseStart: string | null;
    releaseEnd: string | null;
}

/** GET /artist/collections/:id — the collection plus its active drops. */
export interface MyCollectionDetailView extends MyCollectionView {
    /** Active drops by this artist only (at most 100). See `counts.activeDrops`. */
    drops: ArtistDropView[];
}

/** The monitoring view adds who it belongs to. */
export interface AdminCollectionView extends CollectionView {
    artist: {
        id: string;
        /** The artist's account — the `actorId` on their audit events. Null if not yet linked. */
        userId: string | null;
        name: string;
        slug: string;
        isActive: boolean;
        archived: boolean;
    };
    organization: { id: string; name: string } | null;
}

export interface AdminCollectionDetailView extends AdminCollectionView {
    /** The drops filed under it, newest first (at most 100). */
    drops: {
        id: string;
        name: string;
        status: string;
        archivedAt: string | null;
        createdAt: string;
        /** Whether the artist sees it: active and by the collection's own artist. */
        shownToArtist: boolean;
        /** False flags a legacy drop by another artist (new ones are refused). */
        sameArtist: boolean;
    }[];
}

/** One drop in the "Add drops" picker. */
export interface AvailableDropView {
    id: string;
    publicCode: string | null;
    name: string;
    groupCode: string;
    totalSupply: number;
    publishedAt: string | null;
    /**
     * Another of your collections it is in now — only with
     * `includeFiled=true`. Adding it moves it from there.
     */
    currentCollection: { id: string; name: string } | null;
}

/** Why one drop could not be added. Reported per drop, all at once. */
export type AddDropProblem =
    /** No such drop, or it isn't assigned to you. */
    | 'NOT_FOUND'
    /** Not on sale: not ACTIVE, switched off, or archived. */
    | 'NOT_ACTIVE'
    /** Already in this collection. */
    | 'ALREADY_IN_COLLECTION'
    /** In another of your collections — resend with `move: true` to move it. */
    | 'IN_ANOTHER_COLLECTION';

/** POST …/drops and DELETE …/drops/:dropId respond with the collection. */
export interface DropMembershipResult {
    collection: MyCollectionDetailView;
    /** What changed — the drops added (or the one removed). */
    dropIds: string[];
    /** Drops moved here from another collection: dropId → the collection it left. */
    movedFrom: Record<string, string>;
}

export interface CollectionSummaryView {
    total: number;
    live: number;
    archived: number;
    public: number;
    private: number;
    /** Live collections with no live drops. */
    empty: number;
    createdLast30Days: number;
    /** Artists with at least one live collection. */
    artistsWithCollections: number;
    /** The ten artists with the most live collections. */
    topArtists: { artistId: string; name: string; liveCollections: number }[];
}
