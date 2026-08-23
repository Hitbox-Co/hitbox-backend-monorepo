import { PermissionScope, widestScope } from '../enums/permission-scope.enum';
import type {
    AuthzPrincipal,
    PermissionGrant,
    PermissionRequest,
    ResourceRef,
} from '../interfaces/principal.interface';

/**
 * THE DECISION CORE. Pure functions over a principal snapshot — no I/O, no
 * Express, no Prisma — which is why it is cheap to unit-test exhaustively and
 * why there is exactly one place in the codebase where "allowed" is defined.
 *
 * Two questions, deliberately separate (see docs/authorization/06):
 *
 *   1. PERMISSION CHECK — does any role grant this capability at all?
 *      `applicableGrants()` / `resolveScope()`
 *   2. POLICY CHECK     — may they do it to THIS row?
 *      `isResourceAllowed()`
 *
 * Default deny: both answer "no" unless an explicit grant says otherwise.
 */

/**
 * Grants that are live for this request: right resource+action, and reachable
 * from the current tenant context.
 *
 * A grant from organization B is invisible while acting in organization A —
 * this is the single point where cross-tenant leakage is prevented.
 */
export function applicableGrants(
    principal: AuthzPrincipal,
    request: PermissionRequest,
): PermissionGrant[] {
    return principal.grants.filter((grant) => {
        if (grant.resource !== request.resource || grant.action !== request.action) {
            return false;
        }
        // Platform grants (organizationId === null) apply in every context.
        if (grant.organizationId === null) return true;
        // Tenant grants only apply while acting in that same tenant.
        return grant.organizationId === request.organizationId;
    });
}

/**
 * PERMISSION CHECK. True when the user's roles grant the capability in this
 * context, regardless of which row they are about to touch.
 *
 * This is what route middleware uses: it is a cheap gate that rejects the
 * obviously-unauthorized before any database read happens.
 */
export function hasPermission(
    principal: AuthzPrincipal,
    request: PermissionRequest,
): boolean {
    return applicableGrants(principal, request).length > 0;
}

/**
 * The widest scope held for a capability, or null when none is held.
 * Informational: used for the `/authz/me` payload and for log messages, never
 * as the basis of an allow decision (see `isResourceAllowed`).
 */
export function resolveScope(
    principal: AuthzPrincipal,
    request: PermissionRequest,
): PermissionScope | null {
    return widestScope(applicableGrants(principal, request).map((grant) => grant.scope));
}

/** Does ONE grant permit touching this specific row? */
export function grantAllowsResource(
    grant: PermissionGrant,
    principal: AuthzPrincipal,
    resource: ResourceRef,
): boolean {
    switch (grant.scope) {
        case PermissionScope.ANY:
            return true;

        case PermissionScope.ORGANIZATION: {
            // The row must belong to a tenant...
            const rowOrg = resource.organizationId ?? null;
            if (rowOrg === null) return false;
            // ...and to the tenant this grant is scoped to. A platform role
            // carrying an organization-scoped permission would have a null
            // organizationId here; the catalog validator forbids that
            // combination, so treat it as a deny rather than "any tenant".
            return grant.organizationId !== null && grant.organizationId === rowOrg;
        }

        case PermissionScope.OWN: {
            const owner = resource.ownerId ?? null;
            return owner !== null && owner === principal.userId;
        }

        default:
            // Unknown scope: fail closed.
            return false;
    }
}

/**
 * POLICY CHECK. True when ANY applicable grant permits this row.
 *
 * Evaluating grants independently (rather than picking the widest scope and
 * testing only that) is what makes multi-role users behave correctly: someone
 * holding both `product:update:own` and `product:update:organization` can edit
 * their own product that has no tenant AND a tenant product they do not own.
 * Collapsing to the widest scope first would wrongly deny the former.
 */
export function isResourceAllowed(
    principal: AuthzPrincipal,
    request: PermissionRequest,
    resource: ResourceRef,
): boolean {
    return applicableGrants(principal, request).some((grant) =>
        grantAllowsResource(grant, principal, resource),
    );
}

/**
 * True when the capability is marked sensitive in the catalog, meaning the
 * request additionally needs step-up verification. Sensitivity travels with the
 * grant, so no controller has to remember which operations are dangerous.
 */
export function requiresStepUp(
    principal: AuthzPrincipal,
    request: PermissionRequest,
): boolean {
    return applicableGrants(principal, request).some((grant) => grant.sensitive);
}

/** Flat `resource:action:scope` list, for the frontend permission payload. */
export function grantKeys(principal: AuthzPrincipal): string[] {
    const keys = new Set<string>();
    for (const grant of principal.grants) {
        keys.add(`${grant.resource}:${grant.action}:${grant.scope.toLowerCase()}`);
    }
    return [...keys].sort();
}
