import {
    AuthorizationDomain,
    PermissionAction,
    PermissionScope,
    ResourceType,
    RoleScopeType,
} from '@hitbox/database';
import { can, decide, effectivePermissionKeys } from '../src/engine/authorization-engine';
import { ScopeVisibility } from '../src/domain/permission-catalog';
import type { PrincipalGrant } from '../src/domain/interfaces/principal-grants.interface';
import { ORG_A, ORG_B, OTHER_USER, USER, principalWith } from './helpers';

/** A hand-built grant, for cases the role catalog does not cover. */
function grant(overrides: Partial<PrincipalGrant> = {}): PrincipalGrant {
    return {
        resource: ResourceType.ORDER,
        action: PermissionAction.READ,
        scope: PermissionScope.GLOBAL,
        domain: AuthorizationDomain.BUSINESS,
        roleId: 'role_test',
        roleName: 'TEST_ROLE',
        roleDomain: AuthorizationDomain.BUSINESS,
        assignmentScopeType: RoleScopeType.GLOBAL,
        assignmentScopeId: null,
        fieldAllowlist: [],
        ...overrides,
    };
}

describe('default deny', () => {
    it('denies a principal with no grants at all', () => {
        const decision = decide({ userId: USER, grants: [] }, {
            resource: ResourceType.ORDER,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('no grant for order:read');
    });

    it('denies a different resource', () => {
        const principal = { userId: USER, grants: [grant()] };
        expect(
            can(principal, { resource: ResourceType.DROP, action: PermissionAction.READ }),
        ).toBe(false);
    });

    it('denies a different action on a granted resource', () => {
        const principal = { userId: USER, grants: [grant()] };
        expect(
            can(principal, { resource: ResourceType.ORDER, action: PermissionAction.REFUND }),
        ).toBe(false);
    });

    it('distinguishes "no grant" from "out of scope" in the reason', () => {
        const principal = {
            userId: USER,
            grants: [
                grant({
                    scope: PermissionScope.OWN,
                    assignmentScopeType: RoleScopeType.OWN,
                }),
            ],
        };
        const decision = decide(principal, {
            resource: ResourceType.ORDER,
            action: PermissionAction.READ,
            context: { ownerId: OTHER_USER },
        });
        expect(decision.allowed).toBe(false);
        // Matters for auditing: holding a capability but being out of scope is
        // a different event from never having held it.
        expect(decision.reason).toContain('out of scope');
        expect(decision.reason).toContain('belongs to another user');
    });
});

describe('MANAGE expands to CRUD within one resource and scope', () => {
    const manager = {
        userId: USER,
        grants: [grant({ action: PermissionAction.MANAGE })],
    };

    for (const action of [
        PermissionAction.CREATE,
        PermissionAction.READ,
        PermissionAction.UPDATE,
        PermissionAction.DELETE,
    ]) {
        it(`satisfies ${action}`, () => {
            expect(can(manager, { resource: ResourceType.ORDER, action })).toBe(true);
        });
    }

    it('does NOT satisfy REFUND, OVERRIDE, APPROVE or EXPORT', () => {
        for (const action of [
            PermissionAction.REFUND,
            PermissionAction.OVERRIDE,
            PermissionAction.APPROVE,
            PermissionAction.EXPORT,
        ]) {
            expect(can(manager, { resource: ResourceType.ORDER, action })).toBe(false);
        }
    });

    it('does not leak across resources', () => {
        expect(
            can(manager, { resource: ResourceType.DROP, action: PermissionAction.READ }),
        ).toBe(false);
    });
});

describe('organization isolation', () => {
    const brandAdminAtA = principalWith([
        { role: 'BRAND_ADMIN', options: { scopeId: ORG_A } },
    ]);

    it('allows managing a drop in its own organization', () => {
        expect(
            can(brandAdminAtA, {
                resource: ResourceType.DROP,
                action: PermissionAction.UPDATE,
                context: { organizationId: ORG_A },
            }),
        ).toBe(true);
    });

    it("denies managing another organization's drop", () => {
        const decision = decide(brandAdminAtA, {
            resource: ResourceType.DROP,
            action: PermissionAction.UPDATE,
            context: { organizationId: ORG_B },
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('different organization');
    });

    it('denies an org-scoped grant with no organization in context', () => {
        const decision = decide(brandAdminAtA, {
            resource: ResourceType.DROP,
            action: PermissionAction.UPDATE,
            context: {},
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('requires an organization context');
    });

    it('lets a globally-assigned staff role reach every organization', () => {
        const dropManager = principalWith(['HITBOX_DROP_MANAGER']);
        for (const organizationId of [ORG_A, ORG_B]) {
            expect(
                can(dropManager, {
                    resource: ResourceType.DROP,
                    action: PermissionAction.UPDATE,
                    context: { organizationId },
                }),
            ).toBe(true);
        }
    });

    it('refuses to let an ORG-scoped assignment carry a platform-wide permission', () => {
        // Defence against a mis-grant: HITBOX_SYSTEM_ADMIN assigned "within"
        // an organization must not become platform-wide.
        const misassigned = principalWith([
            {
                role: 'HITBOX_SYSTEM_ADMIN',
                options: { scopeType: RoleScopeType.ORGANIZATION, scopeId: ORG_A },
            },
        ]);
        const decision = decide(misassigned, {
            resource: ResourceType.ORDER,
            action: PermissionAction.REFUND,
            context: { organizationId: ORG_A },
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('assigned only within an organization');
    });
});

describe('own-record scoping', () => {
    const buyer = principalWith(['BUYER_COLLECTOR']);

    it('allows reading its own order', () => {
        expect(
            can(buyer, {
                resource: ResourceType.ORDER,
                action: PermissionAction.READ,
                context: { ownerId: USER },
            }),
        ).toBe(true);
    });

    it("denies reading another buyer's order", () => {
        expect(
            can(buyer, {
                resource: ResourceType.ORDER,
                action: PermissionAction.READ,
                context: { ownerId: OTHER_USER },
            }),
        ).toBe(false);
    });

    it('denies an own-scoped grant with no owner in context', () => {
        expect(
            can(buyer, { resource: ResourceType.ORDER, action: PermissionAction.READ }),
        ).toBe(false);
    });

    it('denies role administration outright, rather than returning an empty result', () => {
        // A 403, never a filtered 200 — the buyer holds nothing on this
        // resource, so there is no scope to narrow.
        const decision = decide(buyer, {
            resource: ResourceType.EMPLOYEE_ROLE_MGMT,
            action: PermissionAction.READ,
            context: { ownerId: USER, organizationId: ORG_A },
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('no grant');
    });
});

describe('visibility resolution', () => {
    it('reports MASKED for Support reading a buyer', () => {
        const decision = decide(principalWith(['HITBOX_SUPPORT']), {
            resource: ResourceType.BUYER_PROFILE,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.visibility).toBe(ScopeVisibility.MASKED);
    });

    it('reports PARTIAL for the Order Manager reading the same buyer', () => {
        const decision = decide(principalWith(['HITBOX_ORDER_MANAGER']), {
            resource: ResourceType.BUYER_PROFILE,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.visibility).toBe(ScopeVisibility.PARTIAL);
    });

    it('reports FULL for the System Admin reading the same buyer', () => {
        const decision = decide(principalWith(['HITBOX_SYSTEM_ADMIN']), {
            resource: ResourceType.BUYER_PROFILE,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.visibility).toBe(ScopeVisibility.FULL);
    });

    it('reports PUBLIC for a buyer browsing drops', () => {
        const decision = decide(principalWith(['BUYER_COLLECTOR']), {
            resource: ResourceType.DROP,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.visibility).toBe(ScopeVisibility.PUBLIC);
    });

    it('picks the most revealing satisfiable grant when a principal holds both', () => {
        // Support (masked) + Order Manager (partial) => partial wins.
        const both = principalWith(['HITBOX_SUPPORT', 'HITBOX_ORDER_MANAGER']);
        const decision = decide(both, {
            resource: ResourceType.BUYER_PROFILE,
            action: PermissionAction.READ,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.visibility).toBe(ScopeVisibility.PARTIAL);
    });

    it('does not let a wider-but-unreachable grant beat a narrow reachable one', () => {
        const principal = {
            userId: USER,
            grants: [
                // Global read, but mis-assigned inside an org => unreachable.
                grant({
                    scope: PermissionScope.GLOBAL,
                    assignmentScopeType: RoleScopeType.ORGANIZATION,
                    assignmentScopeId: ORG_A,
                    roleName: 'MISASSIGNED',
                }),
                // Own read, reachable.
                grant({
                    scope: PermissionScope.OWN,
                    assignmentScopeType: RoleScopeType.OWN,
                    roleName: 'OWNER',
                }),
            ],
        };
        const decision = decide(principal, {
            resource: ResourceType.ORDER,
            action: PermissionAction.READ,
            context: { ownerId: USER },
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.roleName).toBe('OWNER');
    });
});

describe('multi-role users (§8)', () => {
    // The brief's own example: an artist who also works for a brand and also
    // writes code.
    const multi = principalWith([
        'ARTIST',
        { role: 'BRAND_EMPLOYEE', options: { scopeId: ORG_A } },
        'HITBOX_FULL_STACK_ENGINEER',
    ]);

    it('is the union of its roles', () => {
        const artistOnly = principalWith(['ARTIST']);
        const engineerOnly = principalWith(['HITBOX_FULL_STACK_ENGINEER']);
        const keys = new Set(effectivePermissionKeys(multi));

        for (const key of effectivePermissionKeys(artistOnly)) {
            expect(keys.has(key)).toBe(true);
        }
        for (const key of effectivePermissionKeys(engineerOnly)) {
            expect(keys.has(key)).toBe(true);
        }
    });

    it('gains no capability that none of its roles hold', () => {
        // Union, not escalation: no role in the stack can refund.
        expect(
            can(multi, {
                resource: ResourceType.ORDER,
                action: PermissionAction.REFUND,
                context: { organizationId: ORG_A, ownerId: USER },
            }),
        ).toBe(false);
        // Nor deploy — the engineer role here is read-and-diagnose only.
        expect(
            can(multi, {
                resource: ResourceType.APPLICATION,
                action: PermissionAction.DEPLOY,
            }),
        ).toBe(false);
    });

    it('keeps each role scoped to where it was granted', () => {
        // BRAND_EMPLOYEE was granted at ORG_A only.
        expect(
            can(multi, {
                resource: ResourceType.DROP,
                action: PermissionAction.UPDATE,
                context: { organizationId: ORG_A },
            }),
        ).toBe(true);
        expect(
            can(multi, {
                resource: ResourceType.DROP,
                action: PermissionAction.UPDATE,
                context: { organizationId: ORG_B },
            }),
        ).toBe(false);
    });

    it('holds both domains only because both roles were granted explicitly', () => {
        const domains = new Set(multi.grants.map((g) => g.domain));
        expect([...domains].sort()).toEqual([
            AuthorizationDomain.BUSINESS,
            AuthorizationDomain.TECHNICAL,
        ]);
    });

    it('reports each held role once per scope in /authz/me terms', () => {
        const roleNames = new Set(multi.grants.map((g) => g.roleName));
        expect([...roleNames].sort()).toEqual([
            'ARTIST',
            'BRAND_EMPLOYEE',
            'HITBOX_FULL_STACK_ENGINEER',
        ]);
    });

    it('deduplicates a capability held through two roles', () => {
        const twice = principalWith(['HITBOX_FINANCE_ADMIN', 'HITBOX_SUPPORT']);
        const keys = effectivePermissionKeys(twice);
        expect(keys.filter((key) => key === 'order:read:global')).toHaveLength(1);
    });
});

describe('field allowlist passthrough', () => {
    it('returns the allowlist from the matching grant', () => {
        const principal = {
            userId: USER,
            grants: [
                grant({
                    action: PermissionAction.UPDATE,
                    fieldAllowlist: ['trackingNote', 'shippedAt'],
                }),
            ],
        };
        const decision = decide(principal, {
            resource: ResourceType.ORDER,
            action: PermissionAction.UPDATE,
        });
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.fieldAllowlist).toEqual(['trackingNote', 'shippedAt']);
    });
});
