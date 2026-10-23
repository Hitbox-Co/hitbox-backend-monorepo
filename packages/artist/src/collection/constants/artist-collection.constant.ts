export const ARTIST_MODULE = 'artist' as const;

/** Fallback used if an ArtistCollection somehow reports a non-positive cap. */
export const DEFAULT_COLLECTION_MAX_LIMIT = 10;

/**
 * Artist collections — an artist curating THEIR OWN series of drops, and
 * HitBox monitoring all of them. docs/artist-collection/.
 *
 * No new permission: a collection is part of the artist's record, so the
 * artist side uses the same `brand-artist-record:*:own` grants as
 * `/artist/me` (held by the ARTIST role only), and the monitoring side uses
 * `brand-artist-record:read` at **global** scope — satisfied by
 * `brand-artist-record:manage:global`, which HITBOX_SYSTEM_ADMIN holds.
 */
export const COLLECTION_READ_CAPABILITY = 'brand-artist-record:read' as const;
export const COLLECTION_WRITE_CAPABILITY = 'brand-artist-record:update' as const;

export const ARTIST_COLLECTION_ERROR_CODES = {
    NOT_FOUND: 'ARTIST_COLLECTION_NOT_FOUND',
    /** Another collection (any artist's) already uses this slug. */
    SLUG_TAKEN: 'ARTIST_COLLECTION_SLUG_TAKEN',
    /** One of your live collections already has this name. */
    NAME_TAKEN: 'ARTIST_COLLECTION_NAME_TAKEN',
    /** Archived collections are read-only. */
    ARCHIVED: 'ARTIST_COLLECTION_ARCHIVED',
    /** It still holds drops that are not retired — archiving would orphan them. */
    HAS_DROPS: 'ARTIST_COLLECTION_HAS_DROPS',
    /** The artist already has the maximum number of live collections. */
    LIMIT_REACHED: 'ARTIST_COLLECTION_LIMIT_REACHED',
    /** The reorder list must name every live collection exactly once. */
    ORDER_MISMATCH: 'ARTIST_COLLECTION_ORDER_MISMATCH',
} as const;

export const COLLECTION_NAME_MAX = 120;
export const COLLECTION_DESCRIPTION_MAX = 2000;
/**
 * Live (non-archived) collections per artist. A guard against runaway
 * clients, not a product rule — raise it freely.
 */
export const MAX_LIVE_COLLECTIONS_PER_ARTIST = 50;

export const ARTIST_COLLECTION_EVENTS = {
    CREATED: 'artist.collection.created',
    UPDATED: 'artist.collection.updated',
    ARCHIVED: 'artist.collection.archived',
    REORDERED: 'artist.collection.reordered',
} as const;

export const COLLECTION_DEFAULT_LIMIT = 20;
export const COLLECTION_MAX_LIMIT = 100;
