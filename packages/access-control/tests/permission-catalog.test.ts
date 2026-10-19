import { AuthorizationDomain, PermissionScope, ResourceType } from '@hitbox/database';
import {
    PERMISSION_CATALOG,
    RESOURCE_DISPLAY,
    SCOPE_REACH,
    ScopeBreadth,
    ScopeVisibility,
    catalogPermissionsForDomain,
    findCatalogPermission,
    isCatalogPermission,
    permissionGroups,
} from '../src/domain/permission-catalog';
import {
    formatPermissionKey,
    parseCapability,
    parsePermissionKey,
} from '../src/domain/permission-key';
import { createRoleSchema } from '../src/dto/access-control.dto';

describe('permission catalog integrity', () => {
    it('is non-empty and has unique keys', () => {
        expect(PERMISSION_CATALOG.length).toBeGreaterThan(0);
        const keys = PERMISSION_CATALOG.map((p) => p.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('has a unique (resource, action, scope) triple per entry', () => {
        // Mirrors the @@unique on the permissions table — a duplicate here
        // would fail the seed at insert time.
        const triples = PERMISSION_CATALOG.map(
            (p) => `${p.resource}|${p.action}|${p.scope}`,
        );
        expect(new Set(triples).size).toBe(triples.length);
    });

    it('stores every key in canonical form', () => {
        for (const permission of PERMISSION_CATALOG) {
            expect(formatPermissionKey(permission)).toBe(permission.key);
        }
    });

    it('gives every entry a description and display metadata', () => {
        for (const permission of PERMISSION_CATALOG) {
            expect(permission.description.length).toBeGreaterThan(0);
            expect(permission.group).toBe(RESOURCE_DISPLAY[permission.resource]);
            expect(permission.actionLabel.length).toBeGreaterThan(0);
            expect(permission.scopeLabel.length).toBeGreaterThan(0);
        }
    });

    it('covers both domains', () => {
        expect(catalogPermissionsForDomain(AuthorizationDomain.BUSINESS).length).toBeGreaterThan(0);
        expect(catalogPermissionsForDomain(AuthorizationDomain.TECHNICAL).length).toBeGreaterThan(0);
    });

    it('partitions cleanly by domain', () => {
        const business = catalogPermissionsForDomain(AuthorizationDomain.BUSINESS).length;
        const technical = catalogPermissionsForDomain(AuthorizationDomain.TECHNICAL).length;
        expect(business + technical).toBe(PERMISSION_CATALOG.length);
    });
});

describe('scope semantics', () => {
    it('decomposes every PermissionScope into breadth and visibility', () => {
        for (const scope of Object.values(PermissionScope)) {
            const reach = SCOPE_REACH[scope];
            expect(reach).toBeDefined();
            expect(Object.values(ScopeBreadth)).toContain(reach.breadth);
            expect(Object.values(ScopeVisibility)).toContain(reach.visibility);
        }
    });

    it('treats the three masking scopes as platform-wide but less revealing', () => {
        for (const scope of [
            PermissionScope.MASKED,
            PermissionScope.MASKED_PARTIAL,
            PermissionScope.PUBLIC,
        ]) {
            expect(SCOPE_REACH[scope].breadth).toBe(ScopeBreadth.ALL);
            expect(SCOPE_REACH[scope].visibility).not.toBe(ScopeVisibility.FULL);
        }
    });

    it('never grants a fully-unmasked location scope', () => {
        // Precise GPS must not be expressible as a permission at all.
        expect(isCatalogPermission('general-location:read:global')).toBe(false);
        expect(isCatalogPermission('general-location:read:masked')).toBe(true);
    });
});

describe('permission key parsing', () => {
    it('round-trips every catalog key', () => {
        for (const permission of PERMISSION_CATALOG) {
            const parsed = parsePermissionKey(permission.key);
            expect(parsed).not.toBeNull();
            expect(formatPermissionKey(parsed!)).toBe(permission.key);
        }
    });

    it('accepts the matrix aliases :any and :org', () => {
        expect(parsePermissionKey('order:read:any')?.scope).toBe(PermissionScope.GLOBAL);
        expect(parsePermissionKey('drop:manage:org')?.scope).toBe(PermissionScope.ORGANIZATION);
    });

    it('rejects malformed and unknown keys', () => {
        for (const bad of [
            'order:read',
            'order:read:global:extra',
            'nonsense:read:global',
            'order:nonsense:global',
            'order:read:nonsense',
            '',
            ':::',
        ]) {
            expect(parsePermissionKey(bad)).toBeNull();
        }
    });

    it('parses two-segment capabilities for route guards', () => {
        expect(parseCapability('order:refund')).toEqual({
            resource: ResourceType.ORDER,
            action: 'REFUND',
        });
        expect(parseCapability('order:refund:global')).toBeNull();
        expect(parseCapability('made-up:refund')).toBeNull();
    });
});

describe('§12 — permissions grouped for the admin UI', () => {
    it('groups by resource with a human label', () => {
        const groups = permissionGroups();
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
            expect(group.group).toBe(RESOURCE_DISPLAY[group.resource]);
            expect(group.permissions.length).toBeGreaterThan(0);
            for (const permission of group.permissions) {
                expect(permission.resource).toBe(group.resource);
            }
        }
    });

    it('accounts for every catalog permission exactly once', () => {
        const grouped = permissionGroups().flatMap((g) => g.permissions);
        expect(grouped).toHaveLength(PERMISSION_CATALOG.length);
        expect(new Set(grouped.map((p) => p.key)).size).toBe(PERMISSION_CATALOG.length);
    });

    it('exposes Application and Infrastructure groups for the technical domain', () => {
        const technical = permissionGroups().filter(
            (g) => g.domain === AuthorizationDomain.TECHNICAL,
        );
        expect(technical.map((g) => g.group).sort()).toEqual([
            'Application',
            'Infrastructure',
            'Ops Dashboards',
            'Platform Configuration',
        ]);
    });
});

describe('§10 — administrators cannot invent permissions', () => {
    const base = {
        name: 'CUSTOM_ROLE',
        displayName: 'Custom Role',
        entityGroup: 'hitbox_seller_org' as const,
        domain: AuthorizationDomain.BUSINESS,
    };

    it('rejects free-typed permission strings', () => {
        for (const invented of [
            'delete-everything',
            'my-custom-permission',
            'whatever-admin-wants',
            'order:refund:*',
            '*',
        ]) {
            const result = createRoleSchema.safeParse({ ...base, permissions: [invented] });
            expect(result.success).toBe(false);
        }
    });

    it('rejects a wildcard even on a real resource', () => {
        expect(
            createRoleSchema.safeParse({ ...base, permissions: ['order:*:global'] }).success,
        ).toBe(false);
    });

    it('accepts a catalog permission', () => {
        expect(
            createRoleSchema.safeParse({ ...base, permissions: ['order:read:global'] }).success,
        ).toBe(true);
    });

    it('rejects an empty permission set — a role must grant something', () => {
        expect(createRoleSchema.safeParse({ ...base, permissions: [] }).success).toBe(false);
    });

    it('rejects duplicates in the selection', () => {
        expect(
            createRoleSchema.safeParse({
                ...base,
                permissions: ['order:read:global', 'order:read:global'],
            }).success,
        ).toBe(false);
    });

    it('rejects a non-conforming role name', () => {
        for (const name of ['lower_case', 'With Spaces', 'a', '1LEADING_DIGIT']) {
            expect(
                createRoleSchema.safeParse({
                    ...base,
                    name,
                    permissions: ['order:read:global'],
                }).success,
            ).toBe(false);
        }
    });

    it('resolves a catalog lookup only for keys that exist', () => {
        expect(findCatalogPermission('order:read:global')).toBeDefined();
        expect(findCatalogPermission('order:read:organization')).toBeDefined();
        // Real resource and action, but a scope no role was ever granted.
        expect(findCatalogPermission('order:read:masked')).toBeUndefined();
        expect(findCatalogPermission('order:restart:global')).toBeUndefined();
    });
});
