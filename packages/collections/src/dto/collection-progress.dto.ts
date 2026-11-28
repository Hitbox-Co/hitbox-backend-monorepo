import { z } from 'zod';
import { COLLECTIONS_DEFAULT_PAGE_SIZE, COLLECTIONS_MAX_PAGE_SIZE } from '../constants/collections.constant';
import type { CollectionDropCard } from '../domain/interfaces/drop-card-catalog.interface';

/** A malformed id is a 404 like any unknown one, not a database error. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const artistIdParamSchema = z.object({
    artistId: z.string().uuid().catch(NIL_UUID),
});

export const collectionIdParamSchema = z.object({
    collectionId: z.string().uuid().catch(NIL_UUID),
});

export const artistCollectionsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(COLLECTIONS_MAX_PAGE_SIZE).default(COLLECTIONS_DEFAULT_PAGE_SIZE),
});

export const collectionDetailQuerySchema = z.object({
    /** Narrow `drops`: only what I own, only what I am missing, or everything. */
    show: z.enum(['all', 'owned', 'missing']).default('all'),
    /** Never an error: a non-uuid, unknown or inactive market is ignored. */
    marketId: z.string().uuid().optional().catch(undefined),
});

export type ArtistCollectionsQueryDto = z.infer<typeof artistCollectionsQuerySchema>;
export type CollectionDetailQueryDto = z.infer<typeof collectionDetailQuerySchema>;

/** How far a buyer is through one collection. Always about the signed-in caller. */
export interface SetProgressDto {
    /** Distinct released drops I own a claimed unit of. */
    owned: number;
    /** Released drops in the collection. */
    total: number;
    /** `total - owned`. */
    missing: number;
    /** round(owned / total × 100); 0 when total is 0. */
    percentage: number;
    /** `total > 0` and nothing missing. */
    complete: boolean;
}

export interface ArtistRefDto {
    id: string;
    name: string;
    slug: string;
}

/** One collection on the artist's profile. */
export interface ArtistCollectionSummaryDto {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    heroImageUrl: string | null;
    /** Released drops in the collection, "of 140". */
    totalDrops: number;
    /** `null` for a guest: there is no "me" to measure. */
    progress: SetProgressDto | null;
}

export interface ArtistCollectionsDto {
    artist: ArtistRefDto;
    items: ArtistCollectionSummaryDto[];
    total: number;
}

export interface SetDropDto extends CollectionDropCard {
    /** I own a claimed unit of it. `null` for a guest. */
    owned: boolean | null;
}

/** One collection, with every drop and which of them I own. */
export interface CollectionProgressDetailDto {
    collection: {
        id: string;
        name: string;
        slug: string;
        description: string | null;
        heroImageUrl: string | null;
        artist: ArtistRefDto;
    };
    /** `null` for a guest. */
    progress: SetProgressDto | null;
    /** Released drops in release order, narrowed by `show`. */
    drops: SetDropDto[];
}

export function toProgress(owned: number, total: number): SetProgressDto {
    return {
        owned,
        total,
        missing: Math.max(total - owned, 0),
        percentage: total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : 0,
        complete: total > 0 && owned >= total,
    };
}
