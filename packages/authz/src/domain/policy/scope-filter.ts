import { PermissionScope } from '../enums/permission-scope.enum';
import type {
    AuthzPrincipal,
    PermissionRequest,
} from '../interfaces/principal.interface';
import { applicableGrants } from './scope-policy';

/**
 * LIST ENDPOINTS
 * ==============
 * `requirePermission` protects a single row: you name the row, it says yes or
 * no. Collections are different — `GET /products` must return *the subset the
 * caller may see*, and filtering after the fact leaks both row counts and
 * pagination state.
 *
 * So instead of checking, we translate the caller's grants into a query filter.
 * The rule stays default-deny: no grants means no filter is produced and the
 * endpoint must return nothing (not everything).
 */
export type ScopeFilter =
    /** No applicable grant. The endpoint must return an empty page. */
    | { visibility: 'none' }
    /** An `any`-scoped grant: no row filtering needed. */
    | { visibility: 'all' }
    /** Restricted to owned rows and/or specific tenants. */
    | {
        visibility: 'restricted';
        /** Non-null when an OWN-scoped grant applies. */
        ownerId: string | null;
        /** Tenants reachable through ORGANIZATION-scoped grants. */
        organizationIds: string[];
    };

export function buildScopeFilter(
    principal: AuthzPrincipal,
    request: PermissionRequest,
): ScopeFilter {
    const grants = applicableGrants(principal, request);
    if (grants.length === 0) return { visibility: 'none' };

    if (grants.some((grant) => grant.scope === PermissionScope.ANY)) {
        return { visibility: 'all' };
    }

    const ownerId = grants.some((grant) => grant.scope === PermissionScope.OWN)
        ? principal.userId
        : null;

    const organizationIds = [
        ...new Set(
            grants
                .filter(
                    (grant) =>
                        grant.scope === PermissionScope.ORGANIZATION &&
                        grant.organizationId !== null,
                )
                .map((grant) => grant.organizationId as string),
        ),
    ];

    return { visibility: 'restricted', ownerId, organizationIds };
}

export interface ScopeFieldMap {
    /** Column holding the owning user id, e.g. `'ownerId'`. */
    ownerField: string;
    /** Column holding the tenant id, e.g. `'organizationId'`. */
    organizationField?: string;
}

/**
 * Turns a ScopeFilter into a Prisma-compatible `where` fragment. Field names are
 * passed in so this stays generic — authz never learns another module's schema.
 *
 *   const where = scopeWhere(filter, { ownerField: 'ownerId', organizationField: 'organizationId' });
 *   if (where === null) return emptyPage();
 *   prisma.product.findMany({ where: { ...userFilters, ...where } });
 *
 * Returns `null` for `visibility: 'none'` — an explicit signal to return
 * nothing, rather than an empty object that would match every row.
 */
export function scopeWhere(
    filter: ScopeFilter,
    fields: ScopeFieldMap,
): Record<string, unknown> | null {
    if (filter.visibility === 'none') return null;
    if (filter.visibility === 'all') return {};

    const clauses: Record<string, unknown>[] = [];

    if (filter.ownerId !== null) {
        clauses.push({ [fields.ownerField]: filter.ownerId });
    }
    if (fields.organizationField && filter.organizationIds.length > 0) {
        clauses.push({ [fields.organizationField]: { in: filter.organizationIds } });
    }

    // A restricted filter with nothing to restrict *to* must match no rows —
    // returning `{}` here would be a tenant-wide data leak.
    if (clauses.length === 0) return null;

    return { OR: clauses };
}
