/**
 * Artist self-service — an artist managing THEIR OWN profile.
 * See docs/artist/artist-profile-api.md.
 */

/**
 * Gates for `/api/v1/artist/me`.
 *
 * Checked at `own` scope against the caller's own user id, so the grant that
 * passes is `brand-artist-record:*:own` — held by the ARTIST role and nobody
 * else in the seeded catalog. A Brand Admin holds the same resource at
 * `:organization` (administering other people's records), which does not
 * reach "own", so this surface is artist-only by capability, never by role
 * name.
 */
export const ARTIST_SELF_READ_CAPABILITY = 'brand-artist-record:read' as const;
export const ARTIST_SELF_UPDATE_CAPABILITY = 'brand-artist-record:update' as const;

export const ARTIST_SELF_ERROR_CODES = {
    /** The caller's account is not linked to any artist profile. */
    PROFILE_NOT_FOUND: 'ARTIST_PROFILE_NOT_FOUND',
    /** The profile is archived or deactivated, so it cannot be edited. */
    PROFILE_LOCKED: 'ARTIST_PROFILE_LOCKED',
    /** Another artist already uses this slug. */
    SLUG_TAKEN: 'ARTIST_SLUG_TAKEN',
    /** `genre` is not one of ARTIST_GENRES. */
    GENRE_INVALID: 'ARTIST_GENRE_INVALID',
    /** No storage bucket configured — image uploads are unavailable. */
    IMAGES_UNAVAILABLE: 'ARTIST_IMAGES_UNAVAILABLE',
    /** The asset is missing, not a profile image, not yours, archived, or not clean. */
    IMAGE_INVALID: 'ARTIST_IMAGE_INVALID',
} as const;

/**
 * The genres an artist can pick from.
 *
 * Stored as the **label** (`Hip-Hop`), so every existing reader of
 * `Artist.genre` — the directory, the storefront — shows something readable
 * without a lookup. Input accepts the code or the label, case-insensitively.
 *
 * Adding a genre is adding a line here; nothing in the database changes.
 */
export const ARTIST_GENRES = [
    { code: 'POP', label: 'Pop' },
    { code: 'HIP_HOP', label: 'Hip-Hop' },
    { code: 'RNB', label: 'R&B' },
    { code: 'ROCK', label: 'Rock' },
    { code: 'ALTERNATIVE', label: 'Alternative' },
    { code: 'INDIE', label: 'Indie' },
    { code: 'ELECTRONIC', label: 'Electronic' },
    { code: 'DANCE', label: 'Dance' },
    { code: 'JAZZ', label: 'Jazz' },
    { code: 'BLUES', label: 'Blues' },
    { code: 'SOUL', label: 'Soul' },
    { code: 'CLASSICAL', label: 'Classical' },
    { code: 'COUNTRY', label: 'Country' },
    { code: 'FOLK', label: 'Folk' },
    { code: 'METAL', label: 'Metal' },
    { code: 'PUNK', label: 'Punk' },
    { code: 'REGGAE', label: 'Reggae' },
    { code: 'LATIN', label: 'Latin' },
    { code: 'AFROBEATS', label: 'Afrobeats' },
    { code: 'K_POP', label: 'K-Pop' },
    { code: 'BOLLYWOOD', label: 'Bollywood' },
    { code: 'INDIAN_CLASSICAL', label: 'Indian Classical' },
    { code: 'DEVOTIONAL', label: 'Devotional' },
    { code: 'SOUNDTRACK', label: 'Soundtrack' },
    { code: 'VISUAL_ART', label: 'Visual Art' },
    { code: 'ILLUSTRATION', label: 'Illustration' },
    { code: 'STREET_ART', label: 'Street Art' },
    { code: 'GAMING', label: 'Gaming' },
    { code: 'SPORTS', label: 'Sports' },
    { code: 'OTHER', label: 'Other' },
] as const;

/** `hip-hop`, `HIP_HOP`, `Hip-Hop` → `Hip-Hop`; anything else → null. */
export function resolveGenre(input: string): string | null {
    const key = input.trim().toLowerCase();
    const match = ARTIST_GENRES.find(
        (g) => g.code.toLowerCase() === key || g.label.toLowerCase() === key ||
            g.code.toLowerCase().replace(/_/g, '-') === key,
    );
    return match?.label ?? null;
}

export const ARTIST_NAME_MAX = 120;
export const ARTIST_BIO_MAX = 2000;
/** `kaze`, `the-midnight-club`. */
export const ARTIST_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ARTIST_SLUG_MIN = 3;
export const ARTIST_SLUG_MAX = 60;

export const ARTIST_SELF_EVENTS = {
    PROFILE_UPDATED: 'artist.profile.updated',
} as const;
