import { describe, expect, it } from '@jest/globals';
import { assertCanGrantRole, uncoveredPermissions } from '../src/domain/grantable-roles';
import { ROLE_CATALOG } from '../src/domain/role-catalog';

/**
 * The no-privilege-escalation rule: you cannot grant a permission you do not
 * hold yourself.
 *
 * The scenario this exists to stop, stated once: a Brand Admin holds
 * `employee-role-mgmt:assign:organization` so they can staff their own brand.
 * Nothing in the route guard looks at *which* role they are handing out. Without
 * this check they could grant HITBOX_SYSTEM_ADMIN — or invite a fresh address to
 * it — and then sign in as an account more powerful than their own.
 */

const roleByName = (name: string) => {
    const role = ROLE_CATALOG.find((candidate) => candidate.name === name);
    if (!role) throw new Error(`no such role in the catalog: ${name}`);
    return role;
};

const SYSTEM_ADMIN = roleByName('HITBOX_SYSTEM_ADMIN');

describe('scope width', () => {
    it('a global grant covers the same permission at any narrower scope', () => {
        expect(uncoveredPermissions(['order:read:global'], ['order:read:own'])).toEqual([]);
        expect(uncoveredPermissions(['order:read:global'], ['order:read:organization'])).toEqual([]);
    });

    it('a narrower grant does NOT cover a wider one', () => {
        expect(uncoveredPermissions(['order:read:own'], ['order:read:global'])).toEqual([
            'order:read:global',
        ]);
        expect(
            uncoveredPermissions(['order:read:organization'], ['order:read:global']),
        ).toEqual(['order:read:global']);
    });
});

describe('action implication', () => {
    it('manage covers the four CRUD verbs on the same resource', () => {
        expect(
            uncoveredPermissions(
                ['drop:manage:global'],
                ['drop:create:global', 'drop:read:global', 'drop:update:global', 'drop:delete:global'],
            ),
        ).toEqual([]);
    });

    it('manage does NOT cover the powers that are not CRUD', () => {
        // override, refund, approve and export are separate powers by design —
        // `manage` must not quietly confer them.
        expect(uncoveredPermissions(['order:manage:global'], ['order:refund:global'])).toEqual([
            'order:refund:global',
        ]);
        expect(
            uncoveredPermissions(['payment-royalty:manage:global'], ['payment-royalty:override:global']),
        ).toEqual(['payment-royalty:override:global']);
    });

    it('read does not cover manage', () => {
        expect(uncoveredPermissions(['drop:read:global'], ['drop:manage:global'])).toEqual([
            'drop:manage:global',
        ]);
    });

    it('does not leak across resources', () => {
        expect(uncoveredPermissions(['drop:manage:global'], ['order:read:global'])).toEqual([
            'order:read:global',
        ]);
    });
});

describe('delegating downwards vs acquiring sideways', () => {
    it('manage at a wider scope covers any action at a narrower one', () => {
        // The case that makes HITBOX_SYSTEM_ADMIN able to grant BRAND_ADMIN:
        // it administers the release queue platform-wide but deliberately does
        // not approve releases itself — that is the brand's job.
        expect(
            uncoveredPermissions(
                ['release-approval:manage:global'],
                ['release-approval:approve:organization', 'release-approval:reject:organization'],
            ),
        ).toEqual([]);
    });

    it('manage does NOT confer a sibling power at the SAME scope', () => {
        // Delegating downwards is administration. Acquiring a sibling power at
        // your own level is escalation — otherwise anyone who administers
        // payments could grant themselves the right to override one.
        expect(
            uncoveredPermissions(
                ['payment-royalty:manage:global'],
                ['payment-royalty:override:global'],
            ),
        ).toEqual(['payment-royalty:override:global']);
    });

    it('an own-scoped permission is always grantable', () => {
        // It acts only on the holder's own records — the engine refuses it
        // without a matching owner context — so it widens nobody's reach.
        expect(uncoveredPermissions([], ['my-collections:manage:own'])).toEqual([]);
        expect(uncoveredPermissions([], ['self-profile:read:own'])).toEqual([]);
    });

    it('but an own-scoped grant still does not cover a wider one', () => {
        expect(uncoveredPermissions(['my-collections:manage:own'], ['my-collections:read:global'])).toEqual(
            ['my-collections:read:global'],
        );
    });
});

describe('assertCanGrantRole', () => {
    it('lets an administrator grant a role they fully cover', () => {
        expect(() =>
            assertCanGrantRole({
                granterPermissions: [...SYSTEM_ADMIN.permissions],
                roleName: SYSTEM_ADMIN.name,
                rolePermissions: [...SYSTEM_ADMIN.permissions],
            }),
        ).not.toThrow();
    });

    it('stops a Brand Admin granting HITBOX_SYSTEM_ADMIN', () => {
        const brandAdmin = roleByName('BRAND_ADMIN');
        expect(() =>
            assertCanGrantRole({
                granterPermissions: [...brandAdmin.permissions],
                roleName: SYSTEM_ADMIN.name,
                rolePermissions: [...SYSTEM_ADMIN.permissions],
            }),
        ).toThrow(/cannot grant HITBOX_SYSTEM_ADMIN/);
    });

    it('names the permissions the caller is short of, not just "denied"', () => {
        // An administrator told only "forbidden" files a ticket; one told what
        // they are missing does not.
        expect(() =>
            assertCanGrantRole({
                granterPermissions: ['order:read:own'],
                roleName: 'SOME_ROLE',
                rolePermissions: ['order:refund:global', 'drop:manage:global'],
            }),
        ).toThrow(/order:refund:global/);
    });

    it('caps the listed examples so the message stays readable', () => {
        const many = Array.from({ length: 9 }, (_, index) => `drop:read:global`).map(
            (key, index) => `${key}${index}`,
        );
        try {
            assertCanGrantRole({
                granterPermissions: [],
                roleName: 'WIDE_ROLE',
                rolePermissions: many,
            });
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as Error).message).toMatch(/and 6 more/);
        }
    });

    it('allows a role with no permissions at all', () => {
        expect(() =>
            assertCanGrantRole({
                granterPermissions: [],
                roleName: 'EMPTY',
                rolePermissions: [],
            }),
        ).not.toThrow();
    });
});

describe('every catalog role is grantable by HITBOX_SYSTEM_ADMIN', () => {
    // If this fails, a role has been defined carrying a permission the highest
    // business role does not hold — which would make it ungrantable by anyone
    // through the API, and is almost certainly a mistake in the catalog rather
    // than an intended state.
    const systemAdminPermissions = [...SYSTEM_ADMIN.permissions];

    for (const role of ROLE_CATALOG.filter(
        (candidate) => candidate.domain === SYSTEM_ADMIN.domain,
    )) {
        it(`${role.name}`, () => {
            expect(
                uncoveredPermissions(systemAdminPermissions, [...role.permissions]),
            ).toEqual([]);
        });
    }
});
