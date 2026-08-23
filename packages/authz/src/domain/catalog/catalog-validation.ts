import { PermissionScope } from '../enums/permission-scope.enum';
import { RoleKind } from '../enums/role-kind.enum';
import { formatPermissionKey, parsePermissionKey } from '../permission-key';
import { PERMISSION_BY_KEY, PERMISSION_CATALOG } from './permission-catalog';
import { ROLE_CATALOG } from './role-catalog';
import { READ_ONLY_ACTIONS, isKnownAction, isKnownResource } from './resources';

/**
 * Structural invariants of the catalogs. Run by a unit test AND by the seeder
 * before it writes anything, so a bad role definition can never reach the
 * database — and therefore can never widen anybody's access by accident.
 *
 * Returns the list of violations rather than throwing on the first one, so a
 * broken catalog is fixed in a single pass.
 */
export function findCatalogViolations(): string[] {
    const violations: string[] = [];

    // ------------------------------------------------- permission invariants
    const seen = new Set<string>();
    for (const permission of PERMISSION_CATALOG) {
        const key = formatPermissionKey(permission);

        try {
            parsePermissionKey(key);
        } catch (error) {
            violations.push((error as Error).message);
            continue;
        }

        if (seen.has(key)) {
            violations.push(
                `Duplicate permission "${key}" — (resource, action, scope) must be unique.`,
            );
        }
        seen.add(key);

        if (!isKnownResource(permission.resource)) {
            violations.push(`Permission "${key}" uses an unregistered resource.`);
        }
        if (!isKnownAction(permission.action)) {
            violations.push(`Permission "${key}" uses an unregistered action.`);
        }
        if (!permission.description.trim()) {
            violations.push(`Permission "${key}" has no description.`);
        }
    }

    // ------------------------------------------------------- role invariants
    const roleKeys = new Set<string>();
    for (const role of ROLE_CATALOG) {
        if (roleKeys.has(role.key)) {
            violations.push(`Duplicate role key "${role.key}".`);
        }
        roleKeys.add(role.key);

        if (role.permissions.length === 0) {
            violations.push(`Role "${role.key}" grants nothing — remove it or give it permissions.`);
        }

        const held = new Set<string>();
        for (const key of role.permissions) {
            if (held.has(key)) {
                violations.push(`Role "${role.key}" lists "${key}" twice.`);
            }
            held.add(key);

            const permission = PERMISSION_BY_KEY.get(key);
            if (!permission) {
                violations.push(
                    `Role "${role.key}" references unknown permission "${key}" — it is not in the permission catalog.`,
                );
                continue;
            }

            // A platform-wide assignment has no tenant to compare against, so an
            // ORGANIZATION-scoped grant on it could never be satisfied.
            if (
                role.kind === RoleKind.PLATFORM &&
                permission.scope === PermissionScope.ORGANIZATION
            ) {
                violations.push(
                    `Role "${role.key}" is PLATFORM but holds organization-scoped "${key}". ` +
                    `Platform roles must use own/any scopes.`,
                );
            }

            // Tenant isolation: an org role may read platform-wide data (the
            // public catalog) but must never WRITE outside its own tenant.
            if (
                role.kind === RoleKind.ORGANIZATION &&
                permission.scope === PermissionScope.ANY &&
                !READ_ONLY_ACTIONS.includes(permission.action)
            ) {
                violations.push(
                    `Role "${role.key}" is ORGANIZATION but holds "${key}" at any-scope with a ` +
                    `mutating action — that breaks tenant isolation.`,
                );
            }

            // Sensitive platform-wide capabilities (money, deletion, role
            // management) are reserved for platform roles.
            if (
                role.kind === RoleKind.ORGANIZATION &&
                permission.scope === PermissionScope.ANY &&
                permission.sensitive
            ) {
                violations.push(
                    `Role "${role.key}" is ORGANIZATION but holds sensitive any-scoped "${key}".`,
                );
            }
        }
    }

    // Privileged roles must be platform roles — an org-level role can never be
    // the thing that mints platform administrators.
    for (const role of ROLE_CATALOG) {
        if (role.isPrivileged && role.kind !== RoleKind.PLATFORM) {
            violations.push(`Role "${role.key}" is privileged but not a PLATFORM role.`);
        }
    }

    return violations;
}

/** Throws a single aggregated error. Called by the seeder before it writes. */
export function assertCatalogIsSound(): void {
    const violations = findCatalogViolations();
    if (violations.length > 0) {
        throw new Error(
            `Authorization catalog is invalid (${violations.length} problem(s)):\n` +
            violations.map((violation) => `  - ${violation}`).join('\n'),
        );
    }
}
