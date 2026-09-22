export const ARTIST_PROFILE_ERROR_CODES = {
    NOT_FOUND: 'ARTIST_NOT_FOUND',
} as const;

/**
 * Reading the artist directory.
 *
 * `drop:read`, for the same reason as the organization directory: this fills
 * the **artist picker on the drop form**, and `HITBOX_DROP_MANAGER` — the role
 * whose entire job is creating drops across every brand — holds no
 * `brand-artist-record` grant.
 *
 * The payload is deliberately the directory, not the profile: id, name, slug,
 * genre, owning organization, and counts. Artist names and genres are printed
 * on the storefront already. Everything that makes an artist record sensitive
 * — the compliance attestation and who signed it, the linked user account,
 * payout terms — is **not** here and stays behind `brand-artist-record:read`.
 */
export const ARTIST_READ_CAPABILITY = 'drop:read' as const;

export const ARTISTS_DEFAULT_LIMIT = 100;
export const ARTISTS_MAX_LIMIT = 200;
