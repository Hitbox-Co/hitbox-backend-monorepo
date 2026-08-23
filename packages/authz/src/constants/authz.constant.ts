export const AUTHZ_MODULE = 'authz' as const;

export const AUTHZ_ERROR_CODES = {
    /** The user's roles do not grant the required capability at all. */
    PERMISSION_DENIED: 'AUTHZ_PERMISSION_DENIED',
    /** Capability granted, but not for THIS resource (wrong owner/tenant). */
    RESOURCE_FORBIDDEN: 'AUTHZ_RESOURCE_FORBIDDEN',
    /** Route needs an organization context and none could be resolved. */
    ORGANIZATION_REQUIRED: 'AUTHZ_ORGANIZATION_REQUIRED',
    /** Requested organization exists but the user is not an active member. */
    ORGANIZATION_FORBIDDEN: 'AUTHZ_ORGANIZATION_FORBIDDEN',
    ORGANIZATION_NOT_FOUND: 'AUTHZ_ORGANIZATION_NOT_FOUND',
    ORGANIZATION_SUSPENDED: 'AUTHZ_ORGANIZATION_SUSPENDED',
    /** Sensitive operation requires a recently verified session (step-up). */
    STEP_UP_REQUIRED: 'AUTHZ_STEP_UP_REQUIRED',
    /** Actor tried to grant a role/permission they do not themselves hold. */
    ESCALATION_BLOCKED: 'AUTHZ_ESCALATION_BLOCKED',
    /** Actor tried to change their own role assignments. */
    SELF_ASSIGNMENT_BLOCKED: 'AUTHZ_SELF_ASSIGNMENT_BLOCKED',
    ROLE_NOT_FOUND: 'AUTHZ_ROLE_NOT_FOUND',
    ROLE_NOT_ASSIGNABLE: 'AUTHZ_ROLE_NOT_ASSIGNABLE',
    ASSIGNMENT_NOT_FOUND: 'AUTHZ_ASSIGNMENT_NOT_FOUND',
    /** requirePermission ran on a route that has no authenticated principal. */
    MISSING_AUTH_CONTEXT: 'AUTHZ_MISSING_AUTH_CONTEXT',
    /** Request arrived on an API surface it is not allowed to use. */
    SURFACE_FORBIDDEN: 'AUTHZ_SURFACE_FORBIDDEN',
} as const;

export const AUTHZ_EVENTS = {
    ROLE_ASSIGNED: 'authz.role.assigned',
    ROLE_REVOKED: 'authz.role.revoked',
    ROLE_PERMISSIONS_CHANGED: 'authz.role.permissions_changed',
    MEMBERSHIP_CHANGED: 'authz.membership.changed',
    PERMISSIONS_INVALIDATED: 'authz.permissions.invalidated',
} as const;

export type AuthzEventName = (typeof AUTHZ_EVENTS)[keyof typeof AUTHZ_EVENTS];

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

/**
 * Every cached principal key embeds the global epoch. Bumping the epoch makes
 * every previously cached entry unreachable in O(1) — used when the role or
 * permission CATALOG changes (which would otherwise require scanning keys).
 * Per-user changes use a targeted DEL instead, which is exact and cheaper.
 */
export const AUTHZ_CACHE = {
    EPOCH_KEY: 'authz:epoch',
    principalKey: (epoch: number, userId: string): string =>
        `authz:principal:v${epoch}:${userId}`,
    /** Prefix used by the targeted-delete path, which must clear every epoch. */
    principalKeyPattern: (userId: string): string => `authz:principal:v*:${userId}`,
} as const;

/** Header a client sends to pick which organization it is acting in. */
export const ORGANIZATION_HEADER = 'x-organization-id';

/** Header identifying the calling application (see API surfaces). */
export const CLIENT_SURFACE_HEADER = 'x-hitbox-surface';
