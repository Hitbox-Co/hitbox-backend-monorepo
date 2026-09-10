import { AuthorizationDomain, PermissionAction, ResourceType } from '@hitbox/database';
import { can } from '../src/engine/authorization-engine';
import {
    PERMISSION_CATALOG,
    RESOURCE_DOMAIN,
    findCatalogPermission,
} from '../src/domain/permission-catalog';
import { ROLE_CATALOG } from '../src/domain/role-catalog';
import {
    BUSINESS_ROLE_NAMES,
    ORG_A,
    TECHNICAL_ROLE_NAMES,
    USER,
    principalWith,
} from './helpers';

/**
 * §5 / §18 — the business ↔ technical boundary.
 *
 * These are the tests that matter most in this package: everything else is
 * plumbing, but a leak here means a deploy key can issue refunds or a brand
 * admin can restart production.
 */

describe('technical roles hold no business capability', () => {
    // The specific crossings the brief calls out by name.
    const FORBIDDEN_FOR_ENGINEERS: { label: string; resource: ResourceType; action: PermissionAction }[] = [
        { label: 'refund an order', resource: ResourceType.ORDER, action: PermissionAction.REFUND },
        { label: 'read an order', resource: ResourceType.ORDER, action: PermissionAction.READ },
        { label: 'manage an order', resource: ResourceType.ORDER, action: PermissionAction.MANAGE },
        {
            label: 'read financial reports',
            resource: ResourceType.REPORTS_DASHBOARDS,
            action: PermissionAction.READ,
        },
        {
            label: 'read payments and royalties',
            resource: ResourceType.PAYMENT_ROYALTY,
            action: PermissionAction.READ,
        },
        {
            label: 'process payments',
            resource: ResourceType.PAYMENT_ROYALTY,
            action: PermissionAction.MANAGE,
        },
        {
            label: 'suspend or administer a user',
            resource: ResourceType.SELF_PROFILE,
            action: PermissionAction.MANAGE,
        },
        {
            label: 'read buyer PII',
            resource: ResourceType.BUYER_PROFILE,
            action: PermissionAction.READ,
        },
        { label: 'manage drops', resource: ResourceType.DROP, action: PermissionAction.MANAGE },
        {
            label: 'assign roles',
            resource: ResourceType.EMPLOYEE_ROLE_MGMT,
            action: PermissionAction.ASSIGN,
        },
    ];

    for (const roleName of TECHNICAL_ROLE_NAMES) {
        describe(roleName, () => {
            const principal = principalWith([roleName]);

            for (const forbidden of FORBIDDEN_FOR_ENGINEERS) {
                it(`cannot ${forbidden.label}`, () => {
                    expect(
                        can(principal, {
                            resource: forbidden.resource,
                            action: forbidden.action,
                            // Most permissive context possible — the denial
                            // must come from the grant set, not a missing id.
                            context: { organizationId: ORG_A, ownerId: USER },
                        }),
                    ).toBe(false);
                });
            }

            it('holds only TECHNICAL-domain grants', () => {
                const domains = new Set(principal.grants.map((g) => g.domain));
                expect([...domains]).toEqual([AuthorizationDomain.TECHNICAL]);
            });
        });
    }

    it('HITBOX_FULL_STACK_ENGINEER does not become HITBOX_SYSTEM_ADMIN', () => {
        const engineer = principalWith(['HITBOX_FULL_STACK_ENGINEER']);
        const admin = principalWith(['HITBOX_SYSTEM_ADMIN']);

        const engineerKeys = new Set(engineer.grants.map((g) => `${g.resource}:${g.action}`));
        const adminKeys = admin.grants.map((g) => `${g.resource}:${g.action}`);

        // Not one admin capability leaks into the engineer.
        expect(adminKeys.filter((key) => engineerKeys.has(key))).toEqual([]);
    });

    it('cannot deploy by stacking every technical role', () => {
        // Stacking is the union, and the union is still entirely technical.
        const stacked = principalWith(TECHNICAL_ROLE_NAMES);
        expect(
            can(stacked, {
                resource: ResourceType.ORDER,
                action: PermissionAction.REFUND,
                context: { organizationId: ORG_A, ownerId: USER },
            }),
        ).toBe(false);
    });
});

describe('business roles hold no technical capability', () => {
    const FORBIDDEN_FOR_BUSINESS: { label: string; resource: ResourceType; action: PermissionAction }[] = [
        {
            label: 'deploy the application',
            resource: ResourceType.APPLICATION,
            action: PermissionAction.DEPLOY,
        },
        {
            label: 'configure the application',
            resource: ResourceType.APPLICATION,
            action: PermissionAction.CONFIGURE,
        },
        {
            label: 'debug the application',
            resource: ResourceType.APPLICATION,
            action: PermissionAction.DEBUG,
        },
        {
            label: 'deploy infrastructure',
            resource: ResourceType.INFRASTRUCTURE,
            action: PermissionAction.DEPLOY,
        },
        {
            label: 'configure infrastructure',
            resource: ResourceType.INFRASTRUCTURE,
            action: PermissionAction.CONFIGURE,
        },
        {
            label: 'restart infrastructure',
            resource: ResourceType.INFRASTRUCTURE,
            action: PermissionAction.RESTART,
        },
        {
            label: 'change platform configuration',
            resource: ResourceType.PLATFORM_CONFIG,
            action: PermissionAction.CONFIGURE,
        },
    ];

    for (const roleName of BUSINESS_ROLE_NAMES) {
        describe(roleName, () => {
            const principal = principalWith([roleName]);

            for (const forbidden of FORBIDDEN_FOR_BUSINESS) {
                it(`cannot ${forbidden.label}`, () => {
                    expect(
                        can(principal, {
                            resource: forbidden.resource,
                            action: forbidden.action,
                            context: { organizationId: ORG_A, ownerId: USER },
                        }),
                    ).toBe(false);
                });
            }

            it('holds only BUSINESS-domain grants', () => {
                const domains = new Set(principal.grants.map((g) => g.domain));
                expect([...domains]).toEqual([AuthorizationDomain.BUSINESS]);
            });
        });
    }

    it('HITBOX_SYSTEM_ADMIN is not a technical bypass', () => {
        // §14 — the most privileged business role is still domain-bounded.
        const admin = principalWith(['HITBOX_SYSTEM_ADMIN']);
        const technicalResources = Object.values(ResourceType).filter(
            (resource) => RESOURCE_DOMAIN[resource] === AuthorizationDomain.TECHNICAL,
        );
        expect(technicalResources.length).toBeGreaterThan(0);

        for (const resource of technicalResources) {
            expect(admin.grants.some((grant) => grant.resource === resource)).toBe(false);
        }
    });

    it('every business role can be stacked without gaining a technical grant', () => {
        const stacked = principalWith(BUSINESS_ROLE_NAMES);
        const domains = new Set(stacked.grants.map((g) => g.domain));
        expect([...domains]).toEqual([AuthorizationDomain.BUSINESS]);
    });
});

describe('catalog-level invariants', () => {
    it('every role holds only permissions from its own domain', () => {
        // The same rule role-catalog.ts asserts at import time, restated as a
        // test so a regression names the offending role rather than crashing
        // the process at boot.
        const violations: string[] = [];
        for (const role of ROLE_CATALOG) {
            for (const key of role.permissions) {
                const permission = findCatalogPermission(key);
                if (permission && permission.domain !== role.domain) {
                    violations.push(`${role.name} (${role.domain}) holds ${key} (${permission.domain})`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it('classifies every resource into exactly one domain', () => {
        for (const resource of Object.values(ResourceType)) {
            expect(RESOURCE_DOMAIN[resource]).toBeDefined();
        }
    });

    it("derives each permission's domain from its resource", () => {
        for (const permission of PERMISSION_CATALOG) {
            expect(permission.domain).toBe(RESOURCE_DOMAIN[permission.resource]);
        }
    });

    it('keeps both domains non-empty', () => {
        expect(BUSINESS_ROLE_NAMES.length).toBeGreaterThan(0);
        expect(TECHNICAL_ROLE_NAMES.length).toBe(2);
    });
});
