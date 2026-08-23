import { findCatalogViolations } from '../src/domain/catalog/catalog-validation';
import {
    PERMISSION_BY_KEY,
    PERMISSION_CATALOG,
    SENSITIVE_PERMISSION_KEYS,
} from '../src/domain/catalog/permission-catalog';
import {
    ALL_PLATFORM_PERMISSIONS,
    ROLE_CATALOG,
    ROLE_KEYS,
    ROLE_BY_KEY,
} from '../src/domain/catalog/role-catalog';
import { PermissionScope } from '../src/domain/enums/permission-scope.enum';
import { RoleKind } from '../src/domain/enums/role-kind.enum';
import { formatPermissionKey, parsePermissionKey } from '../src/domain/permission-key';

/**
 * The catalogs are configuration that decides access, so they get the same
 * scrutiny as code. This suite is what stops a careless role edit from shipping.
 */
describe('catalog invariants', () => {
    it('has no violations', () => {
        expect(findCatalogViolations()).toEqual([]);
    });

    it('every role references only real permissions', () => {
        for (const role of ROLE_CATALOG) {
            for (const key of role.permissions) {
                expect(PERMISSION_BY_KEY.has(key)).toBe(true);
            }
        }
    });

    it('every permission key follows resource:action:scope', () => {
        for (const permission of PERMISSION_CATALOG) {
            const key = formatPermissionKey(permission);
            expect(() => parsePermissionKey(key)).not.toThrow();
        }
    });

    it('no permission describes a UI element', () => {
        // Guard against the classic RBAC failure mode: permissions that name
        // buttons instead of capabilities.
        const uiWords = ['button', 'menu', 'tab', 'page', 'screen', 'modal', 'show', 'hide'];
        for (const permission of PERMISSION_CATALOG) {
            for (const word of uiWords) {
                expect(permission.action).not.toContain(word);
                expect(permission.resource).not.toContain(word);
            }
        }
    });
});

describe('permission naming convention', () => {
    it('rejects a missing scope', () => {
        expect(() => parsePermissionKey('product:update')).toThrow(/resource:action:scope/);
    });

    it('rejects an unknown scope', () => {
        expect(() => parsePermissionKey('product:update:global')).toThrow(/own \| organization \| any/);
    });

    it('rejects non-kebab-case segments', () => {
        expect(() => parsePermissionKey('Product:update:any')).toThrow(/kebab-case/);
        expect(() => parsePermissionKey('product:showDeleteButton:any')).toThrow(/kebab-case/);
    });

    it('accepts multi-word kebab-case resources', () => {
        expect(parsePermissionKey('financial-report:read:organization')).toEqual({
            resource: 'financial-report',
            action: 'read',
            scope: PermissionScope.ORGANIZATION,
        });
    });
});

describe('tenant isolation in the role catalog', () => {
    it('no organization role can write platform-wide', () => {
        for (const role of ROLE_CATALOG) {
            if (role.kind !== RoleKind.ORGANIZATION) continue;
            for (const key of role.permissions) {
                const permission = PERMISSION_BY_KEY.get(key);
                if (permission?.scope !== PermissionScope.ANY) continue;
                // Reads of public data are fine; mutations are not.
                expect(['read', 'export']).toContain(permission.action);
            }
        }
    });

    it('no platform role holds an organization-scoped permission', () => {
        for (const role of ROLE_CATALOG) {
            if (role.kind !== RoleKind.PLATFORM) continue;
            for (const key of role.permissions) {
                expect(PERMISSION_BY_KEY.get(key)?.scope).not.toBe(PermissionScope.ORGANIZATION);
            }
        }
    });

    it('no organization role holds a sensitive platform-wide permission', () => {
        for (const role of ROLE_CATALOG) {
            if (role.kind !== RoleKind.ORGANIZATION) continue;
            for (const key of role.permissions) {
                const permission = PERMISSION_BY_KEY.get(key);
                if (permission?.scope === PermissionScope.ANY) {
                    expect(permission.sensitive).toBe(false);
                }
            }
        }
    });
});

describe('privilege separation', () => {
    const orgAdmin = ROLE_BY_KEY.get(ROLE_KEYS.ORG_ADMIN);
    const platformAdmin = ROLE_BY_KEY.get(ROLE_KEYS.PLATFORM_ADMIN);
    const superAdmin = ROLE_BY_KEY.get(ROLE_KEYS.SUPER_ADMIN);

    it('ORG_ADMIN holds nothing at any-scope except reads', () => {
        expect(orgAdmin).toBeDefined();
        for (const key of orgAdmin?.permissions ?? []) {
            const permission = PERMISSION_BY_KEY.get(key);
            if (permission?.scope === PermissionScope.ANY) {
                expect(permission.action).toBe('read');
            }
        }
    });

    it('ORG_ADMIN cannot assign roles platform-wide', () => {
        expect(orgAdmin?.permissions).toContain('role:assign:organization');
        expect(orgAdmin?.permissions).not.toContain('role:assign:any');
    });

    it('PLATFORM_ADMIN cannot manage roles, delete accounts, or move money', () => {
        const forbidden = [
            'role:assign:any',
            'role:revoke:any',
            'role:update:any',
            'user:delete:any',
            'organization:delete:any',
            'organization:suspend:any',
            'refund:process:any',
            'order:refund:any',
            'transaction:reconcile:any',
            'transaction:export:any',
            'audit-log:export:any',
        ];
        for (const key of forbidden) {
            expect(platformAdmin?.permissions).not.toContain(key);
        }
    });

    it('only privileged PLATFORM roles can hold role:assign:any', () => {
        for (const role of ROLE_CATALOG) {
            if (!role.permissions.includes('role:assign:any')) continue;
            expect(role.kind).toBe(RoleKind.PLATFORM);
            expect(role.isPrivileged).toBe(true);
        }
    });
});

describe('SUPER_ADMIN', () => {
    const superAdmin = ROLE_BY_KEY.get(ROLE_KEYS.SUPER_ADMIN);

    it('is expanded to explicit permissions, never a wildcard', () => {
        // The whole point: a SELECT on role_permissions shows exactly what it
        // can do. Nothing in the request path short-circuits on the role key.
        expect(superAdmin?.permissions.length).toBe(ALL_PLATFORM_PERMISSIONS.length);
        expect(superAdmin?.permissions.length).toBeGreaterThan(50);
        expect(superAdmin?.permissions).not.toContain('*');
    });

    it('excludes organization-scoped permissions, which it cannot use', () => {
        for (const key of superAdmin?.permissions ?? []) {
            expect(PERMISSION_BY_KEY.get(key)?.scope).not.toBe(PermissionScope.ORGANIZATION);
        }
    });

    /**
     * The completeness argument for the exclusion above: every tenant-scoped
     * capability must have an any-scoped counterpart, otherwise SUPER_ADMIN
     * would have a genuine blind spot rather than a redundant one.
     */
    it('has an any-scoped counterpart for every organization-scoped capability', () => {
        const anyCapabilities = new Set(
            PERMISSION_CATALOG.filter((permission) => permission.scope === PermissionScope.ANY).map(
                (permission) => `${permission.resource}:${permission.action}`,
            ),
        );

        const missing = PERMISSION_CATALOG.filter(
            (permission) => permission.scope === PermissionScope.ORGANIZATION,
        )
            .map((permission) => `${permission.resource}:${permission.action}`)
            .filter((capability) => !anyCapabilities.has(capability));

        expect([...new Set(missing)]).toEqual([]);
    });

    it('is the only role that can grant itself', () => {
        const canAssignPlatformWide = ROLE_CATALOG.filter((role) =>
            role.permissions.includes('role:assign:any'),
        ).map((role) => role.key);
        expect(canAssignPlatformWide).toEqual([ROLE_KEYS.SUPER_ADMIN]);
    });
});

describe('sensitive capabilities', () => {
    it('covers role management, deletion and money movement', () => {
        const expected = [
            'role:assign:any',
            'role:assign:organization',
            'role:revoke:any',
            'role:revoke:organization',
            'role:update:any',
            'user:delete:any',
            'user:suspend:any',
            'user:suspend:organization',
            'organization:delete:any',
            'organization:suspend:any',
            'refund:process:any',
            'refund:process:organization',
            'order:refund:any',
            'order:refund:organization',
            'transaction:reconcile:any',
            'transaction:export:any',
            'product:delete:any',
        ];
        for (const key of expected) {
            expect(SENSITIVE_PERMISSION_KEYS).toContain(key);
        }
    });

    it('does not flag ordinary reads', () => {
        expect(SENSITIVE_PERMISSION_KEYS).not.toContain('product:read:any');
        expect(SENSITIVE_PERMISSION_KEYS).not.toContain('profile:read:own');
    });
});

describe('the baseline USER role', () => {
    const user = ROLE_BY_KEY.get(ROLE_KEYS.USER);

    it('is least-privilege: own-scope only, apart from public reads', () => {
        for (const key of user?.permissions ?? []) {
            const permission = PERMISSION_BY_KEY.get(key);
            if (permission?.scope === PermissionScope.ANY) {
                expect(permission.action).toBe('read');
            } else {
                expect(permission?.scope).toBe(PermissionScope.OWN);
            }
        }
    });

    it('holds nothing sensitive', () => {
        for (const key of user?.permissions ?? []) {
            expect(PERMISSION_BY_KEY.get(key)?.sensitive).toBe(false);
        }
    });
});
