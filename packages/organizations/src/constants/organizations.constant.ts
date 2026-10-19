export const ORGANIZATIONS_MODULE = 'organizations' as const;

export const ORGANIZATIONS_ERROR_CODES = {
    NOT_FOUND: 'ORGANIZATIONS_NOT_FOUND',
} as const;

/**
 * Reading the organization directory.
 *
 * `drop:read` rather than `brand-artist-record:read`, and the choice matters.
 *
 * This endpoint exists to fill the **brand picker on the drop form** and to
 * label catalog rows. `HITBOX_DROP_MANAGER` creates drops across every brand
 * and holds no `brand-artist-record` grant at all, so gating on that resource
 * would lock the role out of a picker it cannot do its job without.
 *
 * What makes that safe is the payload: id, name, type, slug and two counts.
 * Brand and artist *names* are already public — they are printed on the
 * storefront next to every product. The artist **profile** (bio, compliance
 * attestation, contact, royalty terms) is a different surface and stays behind
 * `brand-artist-record:read`.
 */
export const ORGANIZATION_READ_CAPABILITY = 'drop:read' as const;

export const ORGANIZATIONS_DEFAULT_LIMIT = 100;
export const ORGANIZATIONS_MAX_LIMIT = 200;
