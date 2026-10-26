/**
 * HitBox staff administering artists — the full profile, stats, the directory
 * summary, and the actions that change an artist's record.
 * See docs/artist/artist-admin-api.md.
 */

/**
 * Gates for the staff artist screens. Both are checked **platform-wide only**
 * (`globalOnly`): `brand-artist-record:manage:global` (System Admin)
 * satisfies them; a Brand Admin's `:organization` grant and an artist's
 * `:own` grant do not.
 *
 * Distinct from the directory's `drop:read` — the directory fills a picker,
 * these expose the account link, compliance, payout and tax state.
 */
export const ARTIST_ADMIN_READ_CAPABILITY = 'brand-artist-record:read' as const;
export const ARTIST_ADMIN_UPDATE_CAPABILITY = 'brand-artist-record:update' as const;

/**
 * Money on these screens (revenue, royalties, payout amounts) additionally
 * needs `payment-royalty:read` at global scope — the dashboard's rule: seeing
 * an artist must never imply seeing what they earn. Without it the money keys
 * are left out of the response, not zeroed.
 */
export const ARTIST_ADMIN_MONEY_CAPABILITY = 'payment-royalty:read' as const;

export const ARTIST_ADMIN_ERROR_CODES = {
    NOT_FOUND: 'ARTIST_NOT_FOUND',
    /** Archived artists can't be edited or changed — restore first. */
    ARCHIVED: 'ARTIST_ARCHIVED',
    /** Restoring an artist that isn't archived. */
    NOT_ARCHIVED: 'ARTIST_NOT_ARCHIVED',
    /** Publishing an inactive artist. */
    INACTIVE: 'ARTIST_INACTIVE',
    /** The action would change nothing (activating an active artist, …). */
    STATE_UNCHANGED: 'ARTIST_STATE_UNCHANGED',
    /** The artist changed between read and write — reload and retry. */
    CHANGED: 'ARTIST_CHANGED',
    SLUG_TAKEN: 'ARTIST_SLUG_TAKEN',
    GENRE_INVALID: 'ARTIST_GENRE_INVALID',
    /** No reporting adapter wired on this server — stats are unavailable. */
    STATS_UNAVAILABLE: 'ARTIST_STATS_UNAVAILABLE',
} as const;

/** Audit event types — registered in @hitbox/audit's AUDIT_EVENT_CATALOG. */
export const ARTIST_ADMIN_AUDIT_EVENTS = {
    UPDATE: 'artist.profile.update',
    COMPLIANCE_ATTEST: 'artist.profile.compliance.attest',
    COMPLIANCE_REVOKE: 'artist.profile.compliance.revoke',
    ACTIVATE: 'artist.profile.activate',
    DEACTIVATE: 'artist.profile.deactivate',
    ARCHIVE: 'artist.profile.archive',
    RESTORE: 'artist.profile.restore',
    PUBLISH: 'artist.profile.publish',
    UNLIST: 'artist.profile.unlist',
} as const;

/** Bus events. `artist.profile.updated` is the same event self-service publishes. */
export const ARTIST_ADMIN_EVENTS = {
    PROFILE_UPDATED: 'artist.profile.updated',
    STATUS_CHANGED: 'artist.profile.status-changed',
} as const;

/** The state actions, and what each one sets. */
export const ARTIST_STATE_ACTIONS = [
    'activate',
    'deactivate',
    'archive',
    'restore',
    'publish',
    'unlist',
] as const;
export type ArtistStateAction = (typeof ARTIST_STATE_ACTIONS)[number];

export const ARTIST_REASON_MAX = 500;
export const TOP_DROPS_DEFAULT = 5;
export const TOP_DROPS_MAX = 20;
export const TOP_ARTISTS_DEFAULT = 5;
export const TOP_ARTISTS_MAX = 20;
