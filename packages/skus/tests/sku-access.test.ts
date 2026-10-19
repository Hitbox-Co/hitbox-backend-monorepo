import { findRoleDefinition } from '@hitbox/access-control';
import {
    ReadScope,
    Visibility,
    buildSkuAccess,
    maskEmail,
    maskTag,
    resolveAccess,
} from '../src/domain/sku-access';
import type { SkuPrincipal } from '../src/domain/sku-access';

/**
 * These tests are the executable half of the visibility matrix in
 * docs/admin/sku-api.md. They are written against the *seeded role catalog*
 * rather than against hand-written permission lists, so a future edit to a
 * role's grants fails here instead of silently changing what an operator sees.
 */

/** Builds a principal holding exactly what the named system role holds. */
function principalFor(roleName: string, organizationId: string | null = null): SkuPrincipal {
    const role = findRoleDefinition(roleName);
    if (!role) throw new Error(`Unknown role ${roleName}`);
    return {
        userId: 'user-1',
        permissions: [...role.permissions],
        roles: [{ roleId: `role-${roleName}`, roleName, organizationId }],
    };
}

describe('resolveAccess', () => {
    it('lets manage satisfy a read question', () => {
        const principal: SkuPrincipal = {
            userId: 'u',
            permissions: ['collectible-instance:manage:global'],
            roles: [],
        };
        expect(resolveAccess(principal, 'collectible-instance')).toEqual({
            scope: ReadScope.GLOBAL,
            visibility: Visibility.FULL,
        });
    });

    it('does not let read satisfy a manage question', () => {
        const principal: SkuPrincipal = {
            userId: 'u',
            permissions: ['nfc-tag-claim:read:global'],
            roles: [],
        };
        expect(resolveAccess(principal, 'nfc-tag-claim', 'manage')).toBeNull();
    });

    it('picks the widest scope when a caller holds several', () => {
        const principal: SkuPrincipal = {
            userId: 'u',
            permissions: ['buyer-profile:read:masked', 'buyer-profile:manage:global'],
            roles: [],
        };
        expect(resolveAccess(principal, 'buyer-profile')?.visibility).toBe(Visibility.FULL);
    });
});

describe('buildSkuAccess — who is refused outright', () => {
    it('refuses a buyer, whose collectible-instance grant is PUBLIC', () => {
        // The regression this exists for: PUBLIC scope has ALL breadth, so a
        // bare requirePermission('collectible-instance:read') on an admin
        // route admits every signed-in buyer on the platform.
        const buyer = principalFor('BUYER_COLLECTOR');
        expect(buyer.permissions).toContain('collectible-instance:read:public');
        expect(() => buildSkuAccess(buyer)).toThrow(/operator access/i);
    });

    it('refuses a role with no collectible-instance grant at all', () => {
        expect(() => buildSkuAccess(principalFor('HITBOX_FINANCE_ADMIN'))).toThrow();
    });

    it('refuses the technical roles, which hold no business data access', () => {
        expect(() => buildSkuAccess(principalFor('HITBOX_PLATFORM_ENGINEER'))).toThrow();
        expect(() => buildSkuAccess(principalFor('HITBOX_FULL_STACK_ENGINEER'))).toThrow();
    });
});

describe('buildSkuAccess — how much each role sees', () => {
    it('gives the System Admin everything', () => {
        const access = buildSkuAccess(principalFor('HITBOX_SYSTEM_ADMIN'));
        expect(access.instance.visibility).toBe(Visibility.FULL);
        expect(access.tag?.visibility).toBe(Visibility.FULL);
        expect(access.buyer?.visibility).toBe(Visibility.FULL);
        expect(access.canSeeMoney).toBe(true);
        expect(access.canManageTags).toBe(true);
        expect(access.organizationIds).toBeNull();
    });

    it('lets the Drop Manager mint but never bind a tag', () => {
        const access = buildSkuAccess(principalFor('HITBOX_DROP_MANAGER'));
        expect(access.instance.visibility).toBe(Visibility.FULL);
        // Holds no nfc-tag-claim grant whatsoever — the tag block is omitted
        // and tag binding is refused.
        expect(access.tag).toBeNull();
        expect(access.canManageTags).toBe(false);
        expect(access.buyer).toBeNull();
        expect(access.order).toBeNull();
        expect(access.canSeeMoney).toBe(false);
    });

    it('confines a Brand Admin to their own organization and shows no tags', () => {
        const access = buildSkuAccess(principalFor('BRAND_ADMIN', 'org-9'));
        expect(access.instance.scope).toBe(ReadScope.ORGANIZATION);
        expect(access.organizationIds).toEqual(['org-9']);
        // Brands own the edition; HitBox owns the anti-counterfeiting material.
        expect(access.tag).toBeNull();
        // No buyer-profile grant either — they see units, not the people
        // holding them.
        expect(access.buyer).toBeNull();
        expect(access.order).not.toBeNull();
        expect(access.canSeeMoney).toBe(true);
    });

    it('gives a Brand Employee the same units with no money', () => {
        const access = buildSkuAccess(principalFor('BRAND_EMPLOYEE', 'org-9'));
        expect(access.instance.scope).toBe(ReadScope.ORGANIZATION);
        expect(access.order).not.toBeNull();
        expect(access.canSeeMoney).toBe(false);
    });

    it('gives an Artist their own org, money, but no order linkage', () => {
        const access = buildSkuAccess(principalFor('ARTIST', 'org-9'));
        expect(access.instance.scope).toBe(ReadScope.ORGANIZATION);
        expect(access.order).toBeNull();
        expect(access.canSeeMoney).toBe(true);
    });

    it('gives Support masked units, real tags and masked buyers', () => {
        const access = buildSkuAccess(principalFor('HITBOX_SUPPORT'));
        expect(access.instance.visibility).toBe(Visibility.MASKED);
        // Support resolves tag disputes, so the tag block is present…
        expect(access.tag?.visibility).toBe(Visibility.FULL);
        // …but it can never write one, and never sees a buyer's address.
        expect(access.canManageTags).toBe(false);
        expect(access.buyer?.visibility).toBe(Visibility.MASKED);
        // `order:read:global` opens the commerce block; it does NOT open the
        // amounts inside it, which need payment-royalty.
        expect(access.order).not.toBeNull();
        expect(access.canSeeMoney).toBe(false);
    });

    /**
     * Two roles that look like they should reach these endpoints and do not.
     * Both are properties of the seeded catalog, not of this module, and both
     * are asserted here so that a catalog edit granting them access is a
     * deliberate change with a failing test attached rather than a surprise.
     */
    it('refuses the Order Manager, who holds no collectible-instance grant', () => {
        const orderManager = principalFor('HITBOX_ORDER_MANAGER');
        expect(
            orderManager.permissions.some((key) => key.startsWith('collectible-instance:')),
        ).toBe(false);
        // They still see the allocated unit of an order through the orders
        // module, which gates on `order:read` — just not this surface.
        expect(() => buildSkuAccess(orderManager)).toThrow(/operator access/i);
    });

    it('refuses the Content Manager, whose grant is update-only', () => {
        const contentManager = principalFor('HITBOX_CONTENT_MANAGER');
        expect(contentManager.permissions).toContain('collectible-instance:update:global');
        // `update` does not imply `read` — only `manage` does, per
        // ACTION_IMPLIES in the permission catalog. The engine would refuse
        // this caller at the route guard for the same reason.
        expect(() => buildSkuAccess(contentManager)).toThrow(/operator access/i);
    });
});

describe('masking', () => {
    it('keeps a partial email correlatable but not readable', () => {
        expect(maskEmail('jane.doe@example.com', Visibility.PARTIAL)).toBe('j***@e***.com');
    });

    it('reveals nothing at MASKED', () => {
        expect(maskEmail('jane.doe@example.com', Visibility.MASKED)).toBe('***@***');
    });

    it('passes the address through at FULL', () => {
        expect(maskEmail('jane.doe@example.com', Visibility.FULL)).toBe('jane.doe@example.com');
    });

    it('survives an address with no domain dot', () => {
        expect(maskEmail('root@localhost', Visibility.PARTIAL)).toBe('r***@l***');
    });

    it('leaves a masked tag unusable for cloning', () => {
        const masked = maskTag('04A39B2C5D6E80');
        expect(masked).toBe('04A39…80');
        expect(masked).not.toContain('B2C5D6E');
    });
});
