import {
    buildSupplyAccess,
    requireConsignmentAccess,
    requireGlobalConsignmentAccess,
    requireReportingAccess,
    requireTagAccess,
    requireWrite,
    ReadScope,
} from '../src/domain/supply-access';
import type { SupplyPrincipal } from '../src/domain/supply-access';

/**
 * Permission lists copied from the role catalog rather than imported, so a
 * change to a role's grants shows up here as a failing expectation about
 * *behaviour* rather than being silently absorbed.
 */
const principal = (
    permissions: string[],
    organizationIds: string[] = [],
): SupplyPrincipal => ({
    userId: 'u-1',
    permissions,
    roles: organizationIds.map((organizationId, index) => ({
        roleId: `r-${index}`,
        roleName: 'ROLE',
        organizationId,
    })),
});

const SYSTEM_ADMIN = [
    'drop:manage:global',
    'nfc-tag-claim:manage:global',
    'reports-dashboards:manage:global',
];
const DROP_MANAGER = [
    'drop:manage:global',
    'collectible-instance:manage:global',
    'reports-dashboards:read:global',
];
const SUPPORT = [
    'buyer-profile:read:masked',
    'nfc-tag-claim:read:global',
    'nfc-tag-claim:update:global',
];
const FINANCE_ADMIN = [
    'payment-royalty:read:global',
    'order:read:global',
    'reports-dashboards:read:global',
];
const BRAND_ADMIN = [
    'drop:manage:organization',
    'reports-dashboards:read:organization',
];
const BUYER = [
    'drop:read:public',
    'collectible-instance:read:public',
    'my-collections:read:own',
];

describe('buildSupplyAccess — a buyer is not an operator', () => {
    it('REFUSES a buyer everywhere, despite drop:read:public matching', () => {
        // The headline case. PUBLIC scope has ALL breadth in this system —
        // visibility is what it narrows, not reach — so a bare
        // requirePermission('drop:read') on these routes admits every signed-in
        // buyer on the platform. The route guard cannot tell; this can.
        const access = buildSupplyAccess(principal(BUYER));

        expect(access.consignment).toBeNull();
        expect(access.tag).toBeNull();
        expect(access.canWrite).toBe(false);
        expect(() => requireConsignmentAccess(access)).toThrow(/operator access/i);
        expect(() => requireTagAccess(access)).toThrow(/operator access/i);
    });

    it('refuses an own-scoped grant too', () => {
        const access = buildSupplyAccess(principal(['drop:read:own']));
        expect(access.consignment).toBeNull();
    });
});

describe('buildSupplyAccess — the three audiences', () => {
    it('gives a system admin everything', () => {
        const access = buildSupplyAccess(principal(SYSTEM_ADMIN));

        expect(access.consignment?.scope).toBe(ReadScope.GLOBAL);
        expect(access.tag?.scope).toBe(ReadScope.GLOBAL);
        expect(access.reporting?.scope).toBe(ReadScope.GLOBAL);
        expect(access.canWrite).toBe(true);
        expect(access.organizationIds).toBeNull();
    });

    it('gives a drop manager consignments and metrics but NOT the chip inventory', () => {
        // The separation the module exists to keep: whoever plans the drop
        // needs to know 5,000 chips arrived; they do not need to know which.
        const access = buildSupplyAccess(principal(DROP_MANAGER));

        expect(access.consignment).not.toBeNull();
        expect(access.reporting).not.toBeNull();
        expect(access.tag).toBeNull();
        expect(access.canWrite).toBe(false);
        expect(() => requireTagAccess(access)).toThrow();
    });

    it('gives support the chip inventory but NOT consignments or metrics', () => {
        const access = buildSupplyAccess(principal(SUPPORT));

        expect(access.tag).not.toBeNull();
        expect(access.consignment).toBeNull();
        expect(access.reporting).toBeNull();
        // `nfc-tag-claim:update` is not `manage`, and update does not imply it.
        expect(access.canWrite).toBe(false);
        expect(() => requireReportingAccess(access)).toThrow(/supply metrics/i);
    });

    it('gives a finance admin metrics with no consignment or chip block', () => {
        const access = buildSupplyAccess(principal(FINANCE_ADMIN));

        expect(access.reporting).not.toBeNull();
        expect(access.consignment).toBeNull();
        expect(access.tag).toBeNull();
    });
});

describe('buildSupplyAccess — organization confinement', () => {
    it('confines an org-scoped caller to their own organizations', () => {
        const access = buildSupplyAccess(principal(BRAND_ADMIN, ['org-a', 'org-b']));

        expect(access.consignment?.scope).toBe(ReadScope.ORGANIZATION);
        expect(access.organizationIds).toEqual(['org-a', 'org-b']);
    });

    it('de-duplicates organizations held through several roles', () => {
        const access = buildSupplyAccess(principal(BRAND_ADMIN, ['org-a', 'org-a']));
        expect(access.organizationIds).toEqual(['org-a']);
    });

    it('leaves a caller unrestricted when ANY held grant reaches global', () => {
        // An org-scoped drop grant plus a global reporting grant must not
        // silently confine the rollup to the organization.
        const access = buildSupplyAccess(
            principal(['drop:manage:organization', 'reports-dashboards:read:global'], ['org-a']),
        );
        expect(access.organizationIds).toBeNull();
    });

    it('gives an org-scoped caller with no assignment an empty list, not null', () => {
        // Empty means "reaches nothing", which is a filter that matches no row.
        // Null would mean "reaches everything" — the opposite.
        const access = buildSupplyAccess(principal(BRAND_ADMIN, []));
        expect(access.organizationIds).toEqual([]);
    });
});

describe('the vendor directory stays platform-level', () => {
    it('refuses an org-scoped caller who may read their own consignments', () => {
        // The leak this closes: `drop:manage:organization` satisfies the route
        // guard, so without this check a brand would receive the platform's
        // whole manufacturer directory — names, contacts and commercial terms
        // that are HitBox's relationships, not theirs.
        const access = buildSupplyAccess(principal(BRAND_ADMIN, ['org-a']));

        expect(() => requireConsignmentAccess(access)).not.toThrow();
        expect(() => requireGlobalConsignmentAccess(access)).toThrow(/platform-wide/i);
    });

    it('admits a global caller', () => {
        expect(() =>
            requireGlobalConsignmentAccess(buildSupplyAccess(principal(DROP_MANAGER))),
        ).not.toThrow();
    });

    it('refuses a caller with no consignment grant at all', () => {
        expect(() =>
            requireGlobalConsignmentAccess(buildSupplyAccess(principal(SUPPORT))),
        ).toThrow(/operator access/i);
    });
});

describe('requireWrite', () => {
    it('admits a manage grant', () => {
        expect(() => requireWrite(buildSupplyAccess(principal(SYSTEM_ADMIN)))).not.toThrow();
    });

    it('refuses a read-only caller', () => {
        expect(() => requireWrite(buildSupplyAccess(principal(DROP_MANAGER)))).toThrow(
            /record supply intake/i,
        );
    });

    it('refuses an update grant — update is not manage', () => {
        expect(() => requireWrite(buildSupplyAccess(principal(SUPPORT)))).toThrow();
    });
});
