import { AuthorizationDomain, RoleScopeType } from '@hitbox/database';
import { ROLE_CATALOG, ROLE_NAMES, findRoleDefinition } from '../src/domain/role-catalog';
import { isCatalogPermission } from '../src/domain/permission-catalog';

/**
 * §17 / §18 — each role receives ONLY its intended permissions.
 *
 * Asserted as exact sets, not "contains": a `toContain` test passes happily
 * while a role quietly accumulates extra grants, which is the failure mode
 * that matters for least privilege.
 */

const EXPECTED: Record<string, string[]> = {
    BUYER_COLLECTOR: [
        'address:manage:own',
        'collectible-instance:read:public',
        'content-unlock:read:own',
        'drop:read:public',
        'my-collections:manage:own',
        'my-collections:read:own',
        'nfc-tag-claim:claim:own',
        'notification-config:update:own',
        'order:create:own',
        'order:read:own',
        'search-discover:read:public',
        'self-profile:read:own',
        'self-profile:update:own',
    ],
    ARTIST: [
        'assets-documents-upload:manage:organization',
        'brand-artist-record:read:own',
        'brand-artist-record:update:own',
        'collectible-instance:manage:organization',
        'content-unlock:manage:organization',
        'drop:manage:organization',
        'notification-config:update:own',
        'payment-royalty:read:own',
        'release-approval:approve:organization',
        'release-approval:read:organization',
        'release-approval:reject:organization',
        'reports-dashboards:read:own',
    ],
    BRAND_ADMIN: [
        'assets-documents-upload:manage:organization',
        'brand-artist-record:read:organization',
        'brand-artist-record:update:organization',
        'collectible-instance:manage:organization',
        'content-unlock:manage:organization',
        'drop:manage:organization',
        'employee-role-mgmt:assign:organization',
        'employee-role-mgmt:read:organization',
        'notification-config:update:organization',
        'order:read:organization',
        'payment-royalty:read:organization',
        'release-approval:approve:organization',
        'release-approval:read:organization',
        'release-approval:reject:organization',
        'reports-dashboards:read:organization',
    ],
    BRAND_EMPLOYEE: [
        'assets-documents-upload:manage:organization',
        'collectible-instance:manage:organization',
        'content-unlock:manage:organization',
        'drop:manage:organization',
        'notification-config:update:organization',
        'order:read:organization',
        'release-approval:read:organization',
        'reports-dashboards:read:organization',
    ],
    HITBOX_SYSTEM_ADMIN: [
        'address:manage:global',
        'age-specific-flag:read:global',
        'assets-documents-upload:manage:global',
        'audit-log:read:global',
        'brand-artist-record:manage:global',
        'buyer-profile:manage:global',
        'collectible-instance:manage:global',
        'content-unlock:manage:global',
        'drop:manage:global',
        'employee-role-mgmt:assign:global',
        'employee-role-mgmt:delete:global',
        'employee-role-mgmt:manage:global',
        'general-location:read:masked',
        'my-collections:read:global',
        'nfc-tag-claim:manage:global',
        'nfc-tag-claim:override:global',
        'notification-config:manage:global',
        'order:manage:global',
        'order:override:global',
        'order:refund:global',
        'payment-royalty:configure:global',
        'payment-royalty:manage:global',
        'payment-royalty:override:global',
        'release-approval:manage:global',
        'release-approval:override:global',
        'reports-dashboards:export:global',
        'reports-dashboards:manage:global',
        'search-discover:manage:global',
        'self-profile:manage:global',
    ],
    HITBOX_DROP_MANAGER: [
        'assets-documents-upload:manage:global',
        'collectible-instance:manage:global',
        'drop:manage:global',
        'general-location:read:masked',
        'release-approval:read:global',
        'reports-dashboards:read:global',
        'search-discover:manage:global',
    ],
    HITBOX_CONTENT_MANAGER: [
        'age-specific-flag:read:masked',
        'assets-documents-upload:manage:global',
        'collectible-instance:update:global',
        'content-unlock:manage:global',
        'drop:read:global',
        'general-location:read:masked',
    ],
    HITBOX_ORDER_MANAGER: [
        'address:read:global',
        'buyer-profile:read:masked-partial',
        'nfc-tag-claim:read:global',
        'order:manage:global',
        'order:refund:global',
    ],
    HITBOX_FINANCE_ADMIN: [
        'order:read:global',
        'payment-royalty:read:global',
        'reports-dashboards:read:global',
    ],
    HITBOX_SUPPORT: [
        'buyer-profile:read:masked',
        'collectible-instance:read:masked',
        'nfc-tag-claim:read:global',
        'nfc-tag-claim:update:global',
        'order:read:global',
    ],
    HITBOX_PLATFORM_ENGINEER: [
        'application:configure:global',
        'application:debug:global',
        'application:deploy:global',
        'application:read:global',
        'infrastructure:configure:global',
        'infrastructure:deploy:global',
        'infrastructure:read:global',
        'infrastructure:restart:global',
        'ops-dashboard-infra:manage:global',
        'platform-config:configure:global',
        'platform-config:read:global',
    ],
    HITBOX_FULL_STACK_ENGINEER: [
        'application:debug:global',
        'application:read:global',
        'infrastructure:read:global',
        'ops-dashboard-infra:read:global',
        'platform-config:read:global',
    ],
};

describe('role catalog', () => {
    it('defines exactly the twelve expected roles', () => {
        expect([...ROLE_NAMES].sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it('excludes HITBOX_DB_ADMIN — database administration is out of scope', () => {
        expect(ROLE_NAMES).not.toContain('HITBOX_DB_ADMIN');
        expect(findRoleDefinition('HITBOX_DB_ADMIN')).toBeUndefined();
    });

    for (const [roleName, expectedPermissions] of Object.entries(EXPECTED)) {
        it(`${roleName} holds exactly its intended permissions`, () => {
            const role = findRoleDefinition(roleName);
            expect(role).toBeDefined();
            expect([...role!.permissions].sort()).toEqual([...expectedPermissions].sort());
        });
    }

    it('references only catalog permissions', () => {
        for (const role of ROLE_CATALOG) {
            for (const key of role.permissions) {
                expect(isCatalogPermission(key)).toBe(true);
            }
        }
    });

    it('never lists a permission twice in one role', () => {
        for (const role of ROLE_CATALOG) {
            expect(new Set(role.permissions).size).toBe(role.permissions.length);
        }
    });

    it('gives brand and artist roles an organization scope', () => {
        for (const role of ROLE_CATALOG.filter((r) => r.entityGroup === 'brand_artist')) {
            expect(role.defaultScopeType).toBe(RoleScopeType.ORGANIZATION);
        }
    });

    it('scopes the buyer role to its own records', () => {
        expect(findRoleDefinition('BUYER_COLLECTOR')!.defaultScopeType).toBe(RoleScopeType.OWN);
    });

    it('marks the two engineering roles TECHNICAL and everything else BUSINESS', () => {
        const technical = ROLE_CATALOG.filter((r) => r.domain === AuthorizationDomain.TECHNICAL);
        expect(technical.map((r) => r.name).sort()).toEqual([
            'HITBOX_FULL_STACK_ENGINEER',
            'HITBOX_PLATFORM_ENGINEER',
        ]);
    });
});

describe('role distinctions the requirements matrix insists on', () => {
    const brandAdmin = findRoleDefinition('BRAND_ADMIN')!;
    const brandEmployee = findRoleDefinition('BRAND_EMPLOYEE')!;

    it('separates Brand Admin from Brand Employee by exactly five capabilities', () => {
        const extra = brandAdmin.permissions.filter(
            (key) => !brandEmployee.permissions.includes(key),
        );
        expect(extra.sort()).toEqual([
            'brand-artist-record:read:organization',
            'brand-artist-record:update:organization',
            'employee-role-mgmt:assign:organization',
            'employee-role-mgmt:read:organization',
            'payment-royalty:read:organization',
            'release-approval:approve:organization',
            'release-approval:reject:organization',
        ]);
    });

    it('denies Brand Employee any approval authority', () => {
        expect(brandEmployee.permissions).toContain('release-approval:read:organization');
        expect(brandEmployee.permissions).not.toContain('release-approval:approve:organization');
        expect(brandEmployee.permissions).not.toContain('release-approval:reject:organization');
    });

    it('hides royalties owed from Brand Employee', () => {
        expect(brandEmployee.permissions.some((k) => k.startsWith('payment-royalty:'))).toBe(false);
    });

    it('gives the Artist own-scoped revenue where the Brand Admin gets org-scoped', () => {
        const artist = findRoleDefinition('ARTIST')!;
        expect(artist.permissions).toContain('reports-dashboards:read:own');
        expect(artist.permissions).not.toContain('reports-dashboards:read:organization');
        expect(brandAdmin.permissions).toContain('reports-dashboards:read:organization');
    });

    it('masks buyer PII differently for Support and the Order Manager', () => {
        expect(findRoleDefinition('HITBOX_SUPPORT')!.permissions).toContain(
            'buyer-profile:read:masked',
        );
        expect(findRoleDefinition('HITBOX_ORDER_MANAGER')!.permissions).toContain(
            'buyer-profile:read:masked-partial',
        );
    });

    it('withholds gateway configuration and the royalty ledger from Finance Admin', () => {
        const finance = findRoleDefinition('HITBOX_FINANCE_ADMIN')!;
        expect(finance.permissions).toContain('payment-royalty:read:global');
        expect(finance.permissions).not.toContain('payment-royalty:configure:global');
        expect(finance.permissions).not.toContain('payment-royalty:manage:global');
    });

    it('never grants precise location to any role', () => {
        for (const role of ROLE_CATALOG) {
            expect(role.permissions).not.toContain('general-location:read:global');
        }
    });
});
