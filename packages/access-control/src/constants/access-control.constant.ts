export const ACCESS_CONTROL_MODULE = 'access-control' as const;

export const ACCESS_CONTROL_ERROR_CODES = {
    /** Default deny — the principal holds no grant satisfying the request. */
    FORBIDDEN: 'AUTHZ_FORBIDDEN',
    /** requirePermission ran on a route that was not behind requireAuth. */
    NO_PRINCIPAL: 'AUTHZ_NO_PRINCIPAL',
    /** The route asked for a permission key that is not in the catalog. */
    UNKNOWN_PERMISSION: 'AUTHZ_UNKNOWN_PERMISSION',
    /** A BUSINESS role was given a TECHNICAL permission, or vice versa. */
    DOMAIN_VIOLATION: 'AUTHZ_DOMAIN_VIOLATION',
    /** An ORG-scoped assignment arrived without an organization id. */
    MISSING_ORG_SCOPE: 'AUTHZ_MISSING_ORG_SCOPE',
    ROLE_NOT_FOUND: 'AUTHZ_ROLE_NOT_FOUND',
    ROLE_NAME_TAKEN: 'AUTHZ_ROLE_NAME_TAKEN',
    /** Catalog-seeded roles cannot be renamed or deleted. */
    ROLE_IMMUTABLE: 'AUTHZ_ROLE_IMMUTABLE',
    ROLE_IN_USE: 'AUTHZ_ROLE_IN_USE',
    ASSIGNMENT_NOT_FOUND: 'AUTHZ_ASSIGNMENT_NOT_FOUND',
    ASSIGNMENT_EXISTS: 'AUTHZ_ASSIGNMENT_EXISTS',
} as const;

export const ACCESS_CONTROL_EVENTS = {
    ROLE_CREATED: 'access-control.role.created',
    ROLE_UPDATED: 'access-control.role.updated',
    ROLE_DELETED: 'access-control.role.deleted',
    ROLE_ASSIGNED: 'access-control.role.assigned',
    ROLE_REVOKED: 'access-control.role.revoked',
} as const;

export type AccessControlEventName =
    (typeof ACCESS_CONTROL_EVENTS)[keyof typeof ACCESS_CONTROL_EVENTS];

// ────────────────────────────────────────────────────────────────────────────
// Grant cache (see src/cache/grants-cache.ts)
// ────────────────────────────────────────────────────────────────────────────

export const AUTHZ_CACHE_KEY_PREFIX = 'authz:grants' as const;

/** Counter whose value namespaces every L2 key; INCR flushes L2 in O(1). */
export const AUTHZ_CACHE_EPOCH_KEY = 'authz:grants:epoch' as const;

/** Channel every instance subscribes to so their in-process L1 can be evicted. */
export const AUTHZ_CACHE_INVALIDATION_CHANNEL = 'authz:grants:invalidate' as const;

/**
 * L1 lifetime. Short on purpose: this is the worst-case staleness window if
 * an invalidation broadcast is missed, and stale authorization data means a
 * revoked role that still works. Invalidation is the primary mechanism —
 * this is the backstop.
 */
export const AUTHZ_CACHE_L1_TTL_MS = 15_000;

/**
 * L1 capacity. ~86 permissions per heavily-granted user, so 5k entries is a
 * few MB worst case — bounded, unlike a plain Map keyed by user id.
 */
export const AUTHZ_CACHE_L1_MAX_ENTRIES = 5_000;

/**
 * L2 lifetime. Longer than L1 because Redis entries are normally evicted
 * precisely (DEL per user, epoch bump for role changes) rather than left to
 * expire — but deliberately only a minute, because this is the window during
 * which a *failed* eviction could keep serving a revoked role. Raising it
 * trades incident blast radius for a slightly warmer cache.
 */
export const AUTHZ_CACHE_L2_TTL_SECONDS = 60;

/** How long a process trusts its cached view of the epoch counter. */
export const AUTHZ_CACHE_EPOCH_TTL_MS = 10_000;
