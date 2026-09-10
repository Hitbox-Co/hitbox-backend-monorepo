import { RoleScopeType } from '@hitbox/database';
import { findCatalogPermission } from '../src/domain/permission-catalog';
import { ROLE_CATALOG, findRoleDefinition } from '../src/domain/role-catalog';
import type { Principal, PrincipalGrant } from '../src/domain/interfaces/principal-grants.interface';

/**
 * Test helpers that build principals from the REAL catalogs and feed them to
 * the REAL engine. Nothing here re-declares what a role may do, so a test
 * cannot drift from the catalog it is meant to be checking — editing a role's
 * permissions changes what these tests see.
 */

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const OTHER_USER = '44444444-4444-4444-8444-444444444444';

export interface RoleGrantOptions {
    /** Defaults to the role's own declared scope. */
    scopeType?: RoleScopeType;
    /** Organization the assignment is scoped to (ORG assignments). */
    scopeId?: string | null;
}

/** Flattens one role assignment into grants, exactly as the repository does. */
export function grantsForRole(roleName: string, options: RoleGrantOptions = {}): PrincipalGrant[] {
    const role = findRoleDefinition(roleName);
    if (!role) throw new Error(`Unknown role in test: ${roleName}`);

    const scopeType = options.scopeType ?? role.defaultScopeType;
    const scopeId =
        scopeType === RoleScopeType.ORGANIZATION ? (options.scopeId ?? ORG_A) : (options.scopeId ?? null);

    return role.permissions.map((key) => {
        const permission = findCatalogPermission(key)!;
        return {
            resource: permission.resource,
            action: permission.action,
            scope: permission.scope,
            domain: permission.domain,
            roleId: `role_${role.name}`,
            roleName: role.name,
            roleDomain: role.domain,
            assignmentScopeType: scopeType,
            assignmentScopeId: scopeId,
            fieldAllowlist: [],
        };
    });
}

/** A principal holding one or more roles — the union, with no inheritance. */
export function principalWith(
    roles: (string | { role: string; options: RoleGrantOptions })[],
    userId = USER,
): Principal {
    return {
        userId,
        grants: roles.flatMap((entry) =>
            typeof entry === 'string'
                ? grantsForRole(entry)
                : grantsForRole(entry.role, entry.options),
        ),
    };
}

export const ALL_ROLE_NAMES = ROLE_CATALOG.map((role) => role.name);

export const BUSINESS_ROLE_NAMES = ROLE_CATALOG.filter((r) => r.domain === 'BUSINESS').map(
    (r) => r.name,
);

export const TECHNICAL_ROLE_NAMES = ROLE_CATALOG.filter((r) => r.domain === 'TECHNICAL').map(
    (r) => r.name,
);
