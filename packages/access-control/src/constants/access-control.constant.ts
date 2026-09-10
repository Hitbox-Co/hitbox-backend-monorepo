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
