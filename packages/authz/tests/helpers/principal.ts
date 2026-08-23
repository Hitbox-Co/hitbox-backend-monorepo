import { PermissionScope } from '../../src/domain/enums/permission-scope.enum';
import { parsePermissionKey } from '../../src/domain/permission-key';
import type {
    AuthzPrincipal,
    PermissionGrant,
} from '../../src/domain/interfaces/principal.interface';

export const USER_ID = 'user_alice';
export const ORG_A = 'org_a';
export const ORG_B = 'org_b';

/**
 * Builds a principal from permission keys. `"product:update:organization@org_a"`
 * tags the grant with a tenant; without `@` the grant is platform-wide.
 */
export function principal(
    keys: readonly string[],
    options: {
        userId?: string;
        organizations?: { id: string; slug?: string; name?: string; roles?: string[] }[];
        platformRoles?: string[];
        sensitive?: readonly string[];
    } = {},
): AuthzPrincipal {
    const sensitive = new Set(options.sensitive ?? []);

    const grants: PermissionGrant[] = keys.map((entry) => {
        const [key, organizationId] = entry.split('@') as [string, string | undefined];
        const parsed = parsePermissionKey(key);
        return {
            resource: parsed.resource,
            action: parsed.action,
            scope: parsed.scope,
            organizationId: organizationId ?? null,
            sensitive: sensitive.has(key),
        };
    });

    return {
        userId: options.userId ?? USER_ID,
        platformRoles: options.platformRoles ?? [],
        organizations: (options.organizations ?? []).map((organization) => ({
            id: organization.id,
            slug: organization.slug ?? organization.id,
            name: organization.name ?? organization.id,
            roles: organization.roles ?? [],
        })),
        grants,
        builtAt: 0,
    };
}

export const ANY = PermissionScope.ANY;
export const ORGANIZATION = PermissionScope.ORGANIZATION;
export const OWN = PermissionScope.OWN;
