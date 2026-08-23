import type { PermissionScope } from '../enums/permission-scope.enum';

/**
 * One (resource, action, scope) capability the user actually holds, tagged with
 * where it came from. `organizationId === null` means the grant came from a
 * PLATFORM role and therefore applies everywhere; otherwise it is confined to
 * that one tenant.
 */
export interface PermissionGrant {
    resource: string;
    action: string;
    scope: PermissionScope;
    organizationId: string | null;
    /** Copied from the permission row so middleware can enforce step-up. */
    sensitive: boolean;
}

export interface OrganizationSummary {
    id: string;
    slug: string;
    name: string;
    /** Role keys the user holds inside this organization. */
    roles: string[];
}

/**
 * The authorization snapshot for one user: every role they hold, every tenant
 * they belong to, and the flattened grant list used for decisions.
 *
 * This is what gets cached in Redis. It is derived state — the relational rows
 * remain the source of truth — so it is always safe to throw away.
 */
export interface AuthzPrincipal {
    userId: string;
    /** Role keys granted platform-wide (organizationId = null). */
    platformRoles: string[];
    /** Active memberships, with the roles held inside each. */
    organizations: OrganizationSummary[];
    grants: PermissionGrant[];
    /** Epoch millis the snapshot was built — surfaced for debugging/observability. */
    builtAt: number;
}

/** What the caller is trying to do. Scope is deliberately absent: the caller
 *  asks for a capability, the policy decides which scope satisfies it. */
export interface PermissionRequest {
    resource: string;
    action: string;
    /**
     * The tenant the request is acting in, resolved by the organization-context
     * middleware. Null means "no tenant context", which only OWN/ANY grants can
     * satisfy.
     */
    organizationId: string | null;
}

/**
 * Identifying facts about the row being touched, for the resource-policy half
 * of the decision. Supplied by whichever module owns the resource.
 */
export interface ResourceRef {
    /** The user who owns the row (`Product.ownerId`, `Order.userId`, ...). */
    ownerId?: string | null;
    /** The tenant the row belongs to (`Product.organizationId`, ...). */
    organizationId?: string | null;
}
