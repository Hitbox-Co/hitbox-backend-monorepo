/**
 * Drop content in the artist panel — the regular and SKU-exclusive content
 * on the artist's own drops. docs/content/drop-content.md.
 *
 * No new permission: like collections, a drop's content is part of the
 * artist's record, so the routes use the same `brand-artist-record:*:own`
 * grants as `/artist/me` (held by the ARTIST role only).
 */

export const ARTIST_DROP_ERROR_CODES = {
    /** Not one of your drops (or it doesn't exist). */
    DROP_NOT_FOUND: 'ARTIST_DROP_NOT_FOUND',
    /** No drop catalog is wired on this deployment. */
    DROPS_UNAVAILABLE: 'ARTIST_DROP_CATALOG_UNAVAILABLE',
    /** No content module is wired on this deployment. */
    CONTENT_UNAVAILABLE: 'ARTIST_DROP_CONTENT_UNAVAILABLE',
} as const;

/** Audit event types — registered in @hitbox/audit's AUDIT_EVENT_CATALOG. */
export const ARTIST_DROP_AUDIT_EVENTS = {
    /** Created, edited (incl. the serial-number list), switched on/off, or restored — metadata.action. */
    CONTENT_SAVE: 'artist.drop.content.save',
    CONTENT_REMOVE: 'artist.drop.content.remove',
    CONTENT_ITEM_ADD: 'artist.drop.content.item.add',
    CONTENT_ITEM_UPDATE: 'artist.drop.content.item.update',
    CONTENT_ITEM_REMOVE: 'artist.drop.content.item.remove',
} as const;

export const ARTIST_DROP_EVENTS = {
    /** A drop's content changed (created, edited, files, removed, restored). */
    CONTENT_CHANGED: 'artist.drop.content-changed',
} as const;
