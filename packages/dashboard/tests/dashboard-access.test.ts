import {
    ReadScope,
    Visibility,
    allows,
    buildAccess,
    requireSection,
    resolveAccess,
} from '../src/domain/dashboard-access';
import type { DashboardPrincipal } from '../src/domain/dashboard-access';

/**
 * The permission → section mapping is the dashboard's security model, so
 * these are written from the real seeded role grants rather than invented
 * permission lists. If a role's catalog entry changes, the fixtures below are
 * the thing to update — and the assertions will say which role broke.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function principal(
    permissions: string[],
    roles: { roleName: string; organizationId: string | null }[] = [],
): DashboardPrincipal {
    return {
        userId: 'u-1',
        permissions,
        roles: roles.map((r, i) => ({ roleId: `role_${i}`, ...r })),
    };
}

// Real grants, copied from the seeded role catalog.
const SYSTEM_ADMIN = principal(
    [
        'reports-dashboards:manage:global', 'buyer-profile:manage:global',
        'employee-role-mgmt:manage:global', 'order:manage:global',
        'payment-royalty:manage:global', 'drop:manage:global',
        'release-approval:manage:global', 'content-unlock:manage:global',
        'brand-artist-record:manage:global', 'nfc-tag-claim:manage:global',
        'audit-log:read:global', 'assets-documents-upload:manage:global',
    ],
    [{ roleName: 'HITBOX_SYSTEM_ADMIN', organizationId: null }],
);

const ORDER_MANAGER = principal(
    [
        'order:manage:global', 'order:refund:global',
        'buyer-profile:read:masked_partial', 'address:read:global',
        'nfc-tag-claim:read:global', 'reports-dashboards:read:global',
    ],
    [{ roleName: 'HITBOX_ORDER_MANAGER', organizationId: null }],
);

const FINANCE_ADMIN = principal(
    ['payment-royalty:read:global', 'order:read:global', 'reports-dashboards:read:global'],
    [{ roleName: 'HITBOX_FINANCE_ADMIN', organizationId: null }],
);

const SUPPORT = principal(
    [
        'buyer-profile:read:masked', 'order:read:global',
        'collectible-instance:read:masked', 'nfc-tag-claim:read:global',
    ],
    [{ roleName: 'HITBOX_SUPPORT', organizationId: null }],
);

const BRAND_ADMIN_A = principal(
    [
        'drop:manage:organization', 'order:read:organization',
        'payment-royalty:read:organization', 'brand-artist-record:read:organization',
        'reports-dashboards:read:organization',
        'assets-documents-upload:manage:organization',
    ],
    [{ roleName: 'BRAND_ADMIN', organizationId: ORG_A }],
);

const PLATFORM_ENGINEER = principal(
    [
        'application:deploy:global', 'application:debug:global',
        'infrastructure:configure:global', 'ops-dashboard-infra:manage:global',
        'platform-config:configure:global',
    ],
    [{ roleName: 'HITBOX_PLATFORM_ENGINEER', organizationId: null }],
);

describe('resolveAccess', () => {
    it('returns nothing for a resource the caller does not hold', () => {
        expect(resolveAccess(ORDER_MANAGER, 'payment-royalty')).toBeNull();
    });

    it('treats manage as satisfying read', () => {
        expect(resolveAccess(SYSTEM_ADMIN, 'order')?.scope).toBe(ReadScope.GLOBAL);
    });

    it('reports the masking level as visibility, not as a denial', () => {
        const support = resolveAccess(SUPPORT, 'buyer-profile');
        expect(support?.scope).toBe(ReadScope.GLOBAL);
        expect(support?.visibility).toBe(Visibility.MASKED);

        const orderManager = resolveAccess(ORDER_MANAGER, 'buyer-profile');
        expect(orderManager?.visibility).toBe(Visibility.PARTIAL);

        const admin = resolveAccess(SYSTEM_ADMIN, 'buyer-profile');
        expect(admin?.visibility).toBe(Visibility.FULL);
    });

    it('resolves an organization grant to ORGANIZATION scope', () => {
        expect(resolveAccess(BRAND_ADMIN_A, 'drop')?.scope).toBe(ReadScope.ORGANIZATION);
    });

    it('picks the strongest scope when several are held', () => {
        const both = principal(['order:read:own', 'order:read:global']);
        expect(resolveAccess(both, 'order')?.scope).toBe(ReadScope.GLOBAL);
    });
});

describe('section visibility per role', () => {
    it('gives the System Admin every section', () => {
        const view = buildAccess(SYSTEM_ADMIN);
        for (const resource of [
            'order', 'payment-royalty', 'drop', 'content-unlock',
            'brand-artist-record', 'audit-log', 'buyer-profile',
        ] as const) {
            expect(allows(view, resource)).toBe(true);
        }
        expect(view.canSeeMoney).toBe(true);
    });

    it('gives the Order Manager orders but never money', () => {
        const view = buildAccess(ORDER_MANAGER);
        expect(allows(view, 'order')).toBe(true);
        expect(allows(view, 'buyer-profile')).toBe(true);
        // The canonical example: order:read must not imply revenue access.
        expect(allows(view, 'payment-royalty')).toBe(false);
        expect(view.canSeeMoney).toBe(false);
    });

    it('gives the Finance Admin money but not the catalog', () => {
        const view = buildAccess(FINANCE_ADMIN);
        expect(view.canSeeMoney).toBe(true);
        expect(allows(view, 'order')).toBe(true);
        expect(allows(view, 'drop')).toBe(false);
        expect(allows(view, 'content-unlock')).toBe(false);
        expect(allows(view, 'buyer-profile')).toBe(false);
    });

    it('gives Support masked reach and no money', () => {
        const view = buildAccess(SUPPORT);
        expect(view.access['buyer-profile']?.visibility).toBe(Visibility.MASKED);
        expect(view.canSeeMoney).toBe(false);
        expect(allows(view, 'drop')).toBe(false);
    });

    it('gives a technical role nothing at all', () => {
        // A TECHNICAL-domain role holds no business resource, so every
        // dashboard section is absent — not empty, absent.
        const view = buildAccess(PLATFORM_ENGINEER);
        for (const resource of [
            'order', 'payment-royalty', 'drop', 'content-unlock',
            'brand-artist-record', 'audit-log', 'buyer-profile',
            'reports-dashboards', 'assets-documents-upload',
        ] as const) {
            expect(allows(view, resource)).toBe(false);
        }
        expect(view.canSeeMoney).toBe(false);
    });
});

describe('organization isolation', () => {
    it('confines an org-scoped caller to their own organization', () => {
        const view = buildAccess(BRAND_ADMIN_A);
        expect(view.organizationIds).toEqual([ORG_A]);
    });

    it('leaves a globally-scoped caller unrestricted', () => {
        expect(buildAccess(SYSTEM_ADMIN).organizationIds).toBeNull();
    });

    it('lets a filter narrow within the granted scope', () => {
        const view = buildAccess(SYSTEM_ADMIN, ORG_B);
        expect(view.organizationIds).toEqual([ORG_B]);
    });

    it("rejects a filter for an organization the caller does not hold", () => {
        // 403, not an empty result: an empty result set would let a caller
        // probe which organizations exist by watching the response shape.
        expect(() => buildAccess(BRAND_ADMIN_A, ORG_B)).toThrow(
            /does not match your granted scope/,
        );
    });

    it('accepts a filter for the org the caller does hold', () => {
        expect(buildAccess(BRAND_ADMIN_A, ORG_A).organizationIds).toEqual([ORG_A]);
    });

    it('cannot be widened by claiming an organization in the request', () => {
        const view = buildAccess(BRAND_ADMIN_A, ORG_A);
        // The filter narrows; it never turns an ORG grant into a GLOBAL one.
        expect(view.access['drop']?.scope).toBe(ReadScope.ORGANIZATION);
    });
});

describe('requireSection', () => {
    it('returns the access when the section is visible', () => {
        expect(requireSection(buildAccess(FINANCE_ADMIN), 'payment-royalty').scope).toBe(
            ReadScope.GLOBAL,
        );
    });

    it('throws 403 when it is not', () => {
        // Sub-endpoints return one section, so there is nothing for an
        // omission to be meaningful against — a denial has to be explicit.
        expect(() => requireSection(buildAccess(ORDER_MANAGER), 'payment-royalty')).toThrow(
            /do not have permission/,
        );
    });
});
