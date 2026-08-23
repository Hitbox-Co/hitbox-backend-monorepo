import { PermissionScope } from '../src/domain/enums/permission-scope.enum';
import {
    applicableGrants,
    hasPermission,
    isResourceAllowed,
    requiresStepUp,
    resolveScope,
} from '../src/domain/policy/scope-policy';
import { buildScopeFilter, scopeWhere } from '../src/domain/policy/scope-filter';
import { ORG_A, ORG_B, USER_ID, principal } from './helpers/principal';

const UPDATE_PRODUCT = { resource: 'product', action: 'update' };

describe('permission check (capability)', () => {
    it('denies by default when the user holds nothing', () => {
        const user = principal([]);
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: null })).toBe(false);
    });

    it('ignores grants for a different resource or action', () => {
        const user = principal(['product:read:any', 'order:update:any']);
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: null })).toBe(false);
    });

    it('honours platform grants in every tenant context', () => {
        const user = principal(['product:update:any']);
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: null })).toBe(true);
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: ORG_A })).toBe(true);
    });

    it('confines a tenant grant to its own tenant', () => {
        const user = principal([`product:update:organization@${ORG_A}`], {
            organizations: [{ id: ORG_A }],
        });
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: ORG_A })).toBe(true);
        // Acting in another tenant: the grant is invisible.
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: ORG_B })).toBe(false);
        // No tenant context at all: also invisible.
        expect(hasPermission(user, { ...UPDATE_PRODUCT, organizationId: null })).toBe(false);
    });

    it('reports the widest scope held, for the frontend manifest', () => {
        const user = principal([
            'product:update:own',
            `product:update:organization@${ORG_A}`,
        ]);
        expect(resolveScope(user, { ...UPDATE_PRODUCT, organizationId: ORG_A })).toBe(
            PermissionScope.ORGANIZATION,
        );
        expect(resolveScope(user, { ...UPDATE_PRODUCT, organizationId: null })).toBe(
            PermissionScope.OWN,
        );
    });
});

describe('resource policy check', () => {
    const request = { ...UPDATE_PRODUCT, organizationId: null };

    it('any-scope permits every row', () => {
        const user = principal(['product:update:any']);
        expect(isResourceAllowed(user, request, { ownerId: 'someone_else' })).toBe(true);
        expect(isResourceAllowed(user, request, { organizationId: ORG_B })).toBe(true);
        expect(isResourceAllowed(user, request, {})).toBe(true);
    });

    it('own-scope permits only rows the user owns', () => {
        const user = principal(['product:update:own']);
        expect(isResourceAllowed(user, request, { ownerId: USER_ID })).toBe(true);
        expect(isResourceAllowed(user, request, { ownerId: 'someone_else' })).toBe(false);
        // An unowned row cannot satisfy own-scope — fail closed.
        expect(isResourceAllowed(user, request, { ownerId: null })).toBe(false);
        expect(isResourceAllowed(user, request, {})).toBe(false);
    });

    it('organization-scope permits only rows in the same tenant', () => {
        const user = principal([`product:update:organization@${ORG_A}`], {
            organizations: [{ id: ORG_A }],
        });
        const inOrgA = { ...UPDATE_PRODUCT, organizationId: ORG_A };

        expect(isResourceAllowed(user, inOrgA, { organizationId: ORG_A })).toBe(true);
        expect(isResourceAllowed(user, inOrgA, { organizationId: ORG_B })).toBe(false);
        // A platform-owned row (no tenant) is not reachable by a tenant grant.
        expect(isResourceAllowed(user, inOrgA, { organizationId: null })).toBe(false);
        // Owning the row does not help: they hold no own-scoped grant.
        expect(isResourceAllowed(user, inOrgA, { ownerId: USER_ID })).toBe(false);
    });

    it('cannot reach another tenant by claiming its context', () => {
        const user = principal([`product:update:organization@${ORG_A}`], {
            organizations: [{ id: ORG_A }],
        });
        // Even if a caller forces organizationId=ORG_B, the ORG_A grant is not
        // applicable and the ORG_B row stays out of reach.
        expect(
            isResourceAllowed(
                user,
                { ...UPDATE_PRODUCT, organizationId: ORG_B },
                { organizationId: ORG_B },
            ),
        ).toBe(false);
    });

    /**
     * The multi-role case that a "collapse to the widest scope" implementation
     * gets wrong: the widest scope is ORGANIZATION, which would reject the
     * user's own tenant-less product even though own-scope allows it.
     */
    it('evaluates each grant independently for multi-role users', () => {
        const user = principal(
            ['product:update:own', `product:update:organization@${ORG_A}`],
            { organizations: [{ id: ORG_A }] },
        );
        const inOrgA = { ...UPDATE_PRODUCT, organizationId: ORG_A };

        // Their own product, no tenant → allowed by the own-scoped grant.
        expect(isResourceAllowed(user, inOrgA, { ownerId: USER_ID, organizationId: null })).toBe(
            true,
        );
        // Somebody else's product inside their tenant → allowed by the org grant.
        expect(
            isResourceAllowed(user, inOrgA, { ownerId: 'someone_else', organizationId: ORG_A }),
        ).toBe(true);
        // Somebody else's product in another tenant → still denied.
        expect(
            isResourceAllowed(user, inOrgA, { ownerId: 'someone_else', organizationId: ORG_B }),
        ).toBe(false);
    });
});

describe('step-up flagging', () => {
    it('is driven by the catalog, not the call site', () => {
        const plain = principal(['order:refund:organization@' + ORG_A]);
        const flagged = principal(['order:refund:organization@' + ORG_A], {
            sensitive: ['order:refund:organization'],
        });
        const request = { resource: 'order', action: 'refund', organizationId: ORG_A };

        expect(requiresStepUp(plain, request)).toBe(false);
        expect(requiresStepUp(flagged, request)).toBe(true);
    });
});

describe('scope filter for list endpoints', () => {
    const request = { resource: 'product', action: 'read', organizationId: ORG_A };
    const fields = { ownerField: 'ownerId', organizationField: 'organizationId' };

    it('returns "none" and a null where-clause when nothing is granted', () => {
        const filter = buildScopeFilter(principal([]), request);
        expect(filter.visibility).toBe('none');
        // null, NOT {} — an empty object would match every row.
        expect(scopeWhere(filter, fields)).toBeNull();
    });

    it('returns "all" and an empty where-clause for any-scope', () => {
        const filter = buildScopeFilter(principal(['product:read:any']), request);
        expect(filter.visibility).toBe('all');
        expect(scopeWhere(filter, fields)).toEqual({});
    });

    it('restricts to owned rows and reachable tenants', () => {
        const user = principal(
            ['product:read:own', `product:read:organization@${ORG_A}`],
            { organizations: [{ id: ORG_A }] },
        );
        const filter = buildScopeFilter(user, request);

        expect(filter).toMatchObject({
            visibility: 'restricted',
            ownerId: USER_ID,
            organizationIds: [ORG_A],
        });
        expect(scopeWhere(filter, fields)).toEqual({
            OR: [{ ownerId: USER_ID }, { organizationId: { in: [ORG_A] } }],
        });
    });

    it('matches no rows when a tenant grant has no reachable tenant', () => {
        // An organization-scoped grant with no tenant context to anchor it.
        const user = principal(['product:read:organization']);
        const filter = buildScopeFilter(user, { ...request, organizationId: null });
        expect(scopeWhere(filter, fields)).toBeNull();
    });

    it('drops the tenant clause when the caller passes no organization field', () => {
        const user = principal([`product:read:organization@${ORG_A}`]);
        const filter = buildScopeFilter(user, request);
        // Resource has no tenant column, so a tenant grant can match nothing.
        expect(scopeWhere(filter, { ownerField: 'ownerId' })).toBeNull();
    });
});

describe('applicableGrants', () => {
    it('excludes grants from tenants other than the active one', () => {
        const user = principal([
            `product:update:organization@${ORG_A}`,
            `product:update:organization@${ORG_B}`,
        ]);
        const grants = applicableGrants(user, { ...UPDATE_PRODUCT, organizationId: ORG_A });
        expect(grants).toHaveLength(1);
        expect(grants[0]?.organizationId).toBe(ORG_A);
    });
});
