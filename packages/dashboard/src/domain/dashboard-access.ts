import { AppError } from '@hitbox/shared';
import { DASHBOARD_ERROR_CODES } from '../constants/dashboard.constant';

/**
 * Turns "what the caller holds" into "what this response may contain".
 *
 * The one rule behind every decision here: **a section is gated by the
 * capability of the resource whose data it exposes, and anything monetary
 * additionally requires `payment-royalty:read`.** That second clause is why
 * an Order Manager sees "12 refunds this week" but not the refunded amount —
 * `order:read` must never imply financial visibility.
 *
 * Nothing in this file mentions a role name. The caller's permission list is
 * the only input.
 */

/** Where a grant reaches, derived from the scope token in its key. */
export const ReadScope = {
    /** Every record. */
    GLOBAL: 'GLOBAL',
    /** Only the organizations the caller holds an ORG assignment for. */
    ORGANIZATION: 'ORGANIZATION',
    /** Only the caller's own records. */
    OWN: 'OWN',
} as const;
export type ReadScope = (typeof ReadScope)[keyof typeof ReadScope];

/** How much of each reached record is visible. */
export const Visibility = {
    FULL: 'FULL',
    PARTIAL: 'PARTIAL',
    MASKED: 'MASKED',
    PUBLIC: 'PUBLIC',
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

export interface ResourceAccess {
    scope: ReadScope;
    visibility: Visibility;
}

/** The authenticated caller, as the guard describes them. */
export interface DashboardPrincipal {
    userId: string;
    /** Canonical permission keys, e.g. `order:read:global`. */
    permissions: string[];
    roles: { roleId: string; roleName: string; organizationId: string | null }[];
}

const SCOPE_RANK: Record<string, number> = {
    own: 1,
    organization: 2,
    public: 3,
    masked: 4,
    masked_partial: 5,
    global: 6,
};

const SCOPE_TO_READ: Record<string, ReadScope> = {
    own: ReadScope.OWN,
    organization: ReadScope.ORGANIZATION,
    // The masking scopes reach every record; they differ in visibility only.
    public: ReadScope.GLOBAL,
    masked: ReadScope.GLOBAL,
    masked_partial: ReadScope.GLOBAL,
    global: ReadScope.GLOBAL,
};

const SCOPE_TO_VISIBILITY: Record<string, Visibility> = {
    own: Visibility.FULL,
    organization: Visibility.FULL,
    global: Visibility.FULL,
    masked_partial: Visibility.PARTIAL,
    masked: Visibility.MASKED,
    public: Visibility.PUBLIC,
};

/** `MANAGE` covers CRUD, so it satisfies a `read` question. */
const ACTION_SATISFIES_READ = new Set(['read', 'manage']);

/**
 * The strongest access the caller holds for `resource:action`, or null if
 * they hold none. Scope comes from the grant, never from the request.
 */
export function resolveAccess(
    principal: DashboardPrincipal,
    resource: string,
    action = 'read',
): ResourceAccess | null {
    let best: { scope: string; rank: number } | null = null;

    for (const key of principal.permissions) {
        const [keyResource, keyAction, keyScope] = key.split(':');
        if (keyResource !== resource || !keyScope || !keyAction) continue;

        const satisfies =
            keyAction === action ||
            (action === 'read' && ACTION_SATISFIES_READ.has(keyAction));
        if (!satisfies) continue;

        const rank = SCOPE_RANK[keyScope] ?? 0;
        if (!best || rank > best.rank) best = { scope: keyScope, rank };
    }

    if (!best) return null;
    return {
        scope: SCOPE_TO_READ[best.scope] ?? ReadScope.OWN,
        visibility: SCOPE_TO_VISIBILITY[best.scope] ?? Visibility.FULL,
    };
}

export function can(
    principal: DashboardPrincipal,
    resource: string,
    action = 'read',
): boolean {
    return resolveAccess(principal, resource, action) !== null;
}

/**
 * The resolved view for one request: which sections are visible, at what
 * scope, and which organizations the query must be confined to.
 */
export interface DashboardAccess {
    principal: DashboardPrincipal;
    /** Resource -> access, for every resource the dashboard reads. */
    access: Record<string, ResourceAccess | null>;
    /**
     * Organization ids every query must be filtered to, or null for an
     * unrestricted (GLOBAL) caller. Derived from the caller's ORG role
     * assignments plus any client filter that falls inside them.
     */
    organizationIds: string[] | null;
    /** True when the caller may see money at all. */
    canSeeMoney: boolean;
}

/** The resources the dashboard reads. */
export const DASHBOARD_RESOURCES = [
    'reports-dashboards',
    'buyer-profile',
    'employee-role-mgmt',
    'order',
    'payment-royalty',
    'drop',
    'release-approval',
    'content-unlock',
    'brand-artist-record',
    'nfc-tag-claim',
    'collectible-instance',
    'audit-log',
    'assets-documents-upload',
    'notification-config',
] as const;

/**
 * Builds the request's access view and enforces organization isolation.
 *
 * `requestedOrganizationId` is a **filter**, never a grant: it can only narrow
 * a scope the caller already holds. A caller who sends an organization they
 * hold nothing for gets 403 — not an empty result set, which would let them
 * probe which organizations exist by watching response shapes.
 */
export function buildAccess(
    principal: DashboardPrincipal,
    requestedOrganizationId?: string | undefined,
): DashboardAccess {
    const access: Record<string, ResourceAccess | null> = {};
    for (const resource of DASHBOARD_RESOURCES) {
        access[resource] = resolveAccess(principal, resource);
    }

    // Organizations reachable through the caller's ORG-scoped assignments.
    const grantedOrgIds = [
        ...new Set(
            principal.roles
                .map((role) => role.organizationId)
                .filter((id): id is string => id !== null),
        ),
    ];

    // A caller is unrestricted only if some resource they hold reaches GLOBAL.
    const hasGlobalReach = Object.values(access).some(
        (entry) => entry?.scope === ReadScope.GLOBAL,
    );

    let organizationIds: string[] | null;
    if (requestedOrganizationId) {
        if (!hasGlobalReach && !grantedOrgIds.includes(requestedOrganizationId)) {
            throw AppError.forbidden(
                'organizationId does not match your granted scope.',
                DASHBOARD_ERROR_CODES.SCOPE_MISMATCH,
            );
        }
        organizationIds = [requestedOrganizationId];
    } else {
        organizationIds = hasGlobalReach ? null : grantedOrgIds;
    }

    return {
        principal,
        access,
        organizationIds,
        canSeeMoney: access['payment-royalty'] !== null && access['payment-royalty'] !== undefined,
    };
}

/** Convenience reader — `null` means the section is omitted. */
export function accessFor(
    view: DashboardAccess,
    resource: (typeof DASHBOARD_RESOURCES)[number],
): ResourceAccess | null {
    return view.access[resource] ?? null;
}

export function allows(
    view: DashboardAccess,
    resource: (typeof DASHBOARD_RESOURCES)[number],
): boolean {
    return accessFor(view, resource) !== null;
}

/**
 * Guard for the sub-endpoints, which return one section directly rather than
 * omitting it. A caller with no grant for that section gets 403.
 */
export function requireSection(
    view: DashboardAccess,
    resource: (typeof DASHBOARD_RESOURCES)[number],
): ResourceAccess {
    const resolved = accessFor(view, resource);
    if (!resolved) {
        throw AppError.forbidden(
            'You do not have permission to view this resource.',
            DASHBOARD_ERROR_CODES.FORBIDDEN,
        );
    }
    return resolved;
}
