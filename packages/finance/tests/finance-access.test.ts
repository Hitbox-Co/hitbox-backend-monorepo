import { describe, expect, it } from '@jest/globals';
import {
    buildFinanceAccess,
    FinanceScope,
    requireManage,
    requireOverride,
} from '../src/domain/finance-access';
import { royaltyEntryScope } from '../src/domain/scope-filter';

const principal = (permissions: string[], organizationIds: (string | null)[] = []) => ({
    userId: 'user-1',
    permissions,
    roles: organizationIds.map((organizationId, index) => ({
        roleId: `role-${index}`,
        roleName: 'ROLE',
        organizationId,
    })),
});

/**
 * The design document's RBAC requirement is one sentence — *"Artist can only
 * see own royalties, HitBox Admin sees all"* — and it is the most consequential
 * rule in the module, because what leaks is another party's revenue.
 */
describe('buildFinanceAccess', () => {
    it('gives a global reader unrestricted scope', () => {
        const access = buildFinanceAccess(principal(['payment-royalty:read:global']));
        expect(access.scope).toBe(FinanceScope.GLOBAL);
        expect(access.organizationIds).toBeNull();
    });

    it('confines an organization reader to their own organizations', () => {
        const access = buildFinanceAccess(
            principal(['payment-royalty:read:organization'], ['org-1', 'org-2', null]),
        );
        expect(access.scope).toBe(FinanceScope.ORGANIZATION);
        expect(access.organizationIds).toEqual(['org-1', 'org-2']);
    });

    it('gives an artist OWN scope', () => {
        const access = buildFinanceAccess(principal(['payment-royalty:read:own']));
        expect(access.scope).toBe(FinanceScope.OWN);
    });

    it('refuses a caller with no payment-royalty grant at all', () => {
        expect(() => buildFinanceAccess(principal(['order:read:global']))).toThrow(
            /do not have access/i,
        );
    });

    it('takes the strongest scope when a caller holds several', () => {
        const access = buildFinanceAccess(
            principal(['payment-royalty:read:own', 'payment-royalty:read:global']),
        );
        expect(access.scope).toBe(FinanceScope.GLOBAL);
    });

    it('treats manage and override as implying read', () => {
        const access = buildFinanceAccess(principal(['payment-royalty:manage:global']));
        expect(access.scope).toBe(FinanceScope.GLOBAL);
        expect(access.canManage).toBe(true);
    });

    /**
     * Read is not write. A Finance Admin who may see every royalty on the
     * platform still cannot schedule a payout unless they hold `manage`.
     */
    it('does not let a global reader manage or override', () => {
        const access = buildFinanceAccess(principal(['payment-royalty:read:global']));
        expect(access.canManage).toBe(false);
        expect(access.canOverride).toBe(false);
        expect(() => requireManage(access, 'schedule payouts')).toThrow(/permission/i);
        expect(() => requireOverride(access, 'reverse a posting')).toThrow(/permission/i);
    });

    /** An org-scoped manage grant is not a platform-wide one. */
    it('does not accept an organization-scoped manage grant as manage', () => {
        const access = buildFinanceAccess(
            principal(['payment-royalty:manage:organization'], ['org-1']),
        );
        expect(access.canManage).toBe(false);
    });
});

describe('royaltyEntryScope', () => {
    const resolveArtist = async () => 'artist-123';

    it('applies no filter for a global reader', async () => {
        const filter = await royaltyEntryScope(
            buildFinanceAccess(principal(['payment-royalty:read:global'])),
            resolveArtist,
        );
        expect(filter).toEqual({});
    });

    it('confines an artist to their own payee id', async () => {
        const filter = await royaltyEntryScope(
            buildFinanceAccess(principal(['payment-royalty:read:own'])),
            resolveArtist,
        );
        expect(filter).toEqual({ payeeArtistId: 'artist-123' });
    });

    /**
     * Fail closed: an OWN-scoped caller with no artist profile must match
     * nothing, not everything. A refactor that loses the artist lookup should
     * return zero rows, not the platform's entire royalty ledger.
     */
    it('matches nothing when an own-scoped caller has no artist profile', async () => {
        const filter = await royaltyEntryScope(
            buildFinanceAccess(principal(['payment-royalty:read:own'])),
            async () => null,
        );
        expect(filter).toEqual({ payeeArtistId: '00000000-0000-0000-0000-000000000000' });
    });

    it('lets an organization reader see its own royalties and its artists’', async () => {
        const filter = await royaltyEntryScope(
            buildFinanceAccess(principal(['payment-royalty:read:organization'], ['org-1'])),
            resolveArtist,
        );
        expect(filter).toEqual({
            OR: [
                { payeeOrganizationId: { in: ['org-1'] } },
                { payeeArtist: { organizationId: { in: ['org-1'] } } },
            ],
        });
    });
});
