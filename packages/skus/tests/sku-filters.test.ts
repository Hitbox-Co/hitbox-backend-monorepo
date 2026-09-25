import { describe, expect, it } from '@jest/globals';
import {
    assertFiltersPermitted,
    forbiddenFilters,
    searchMayMatchTag,
} from '../src/domain/sku-filters';
import { ReadScope, Visibility } from '../src/domain/sku-access';
import type { SkuAccess } from '../src/domain/sku-access';

/**
 * A filter is a read of the column it names.
 *
 * The response projection omits a tag UID from a caller without
 * `nfc-tag-claim`. Without this gate, `?tagId=04A39B2C5D6E80` hands them the
 * same fact anyway: one row back means yes, zero means no, and enough of those
 * questions is the whole secret. These tests are the oracle, stated.
 */

const FULL = { scope: ReadScope.GLOBAL, visibility: Visibility.FULL };
const MASKED = { scope: ReadScope.GLOBAL, visibility: Visibility.MASKED };

const access = (overrides: Partial<SkuAccess> = {}): SkuAccess => ({
    userId: 'admin-1',
    instance: FULL,
    tag: null,
    buyer: null,
    order: null,
    canSeeMoney: false,
    canManageTags: false,
    canManageUnits: true,
    organizationIds: null,
    ...overrides,
});

/** A Drop Manager: sees units and trust flags, no tags, no buyers. */
const dropManager = access();
/** Support: real tag UIDs, masked units, masked buyers. */
const support = access({ instance: MASKED, tag: FULL, buyer: MASKED });
const systemAdmin = access({ tag: FULL, buyer: FULL, canManageTags: true });

describe('tag filters', () => {
    it.each(['tagId', 'vendorId', 'provisioningBatchId'])(
        'refuses %s to a caller who is shown no tags',
        (key) => {
            expect(forbiddenFilters({ [key]: 'x' }, dropManager)).toEqual([key]);
        },
    );

    it('allows them to a caller who sees tags in full', () => {
        expect(
            forbiddenFilters(
                { tagId: '04A39B2C5D6E80', vendorId: 'v-1', provisioningBatchId: 'B-1' },
                support,
            ),
        ).toEqual([]);
    });

    it('still allows the population filters a rollout depends on', () => {
        // `?tagged=false` is the documented way a Drop Manager finds the units
        // still waiting for a tag. No amount of asking it yields a UID.
        expect(
            forbiddenFilters({ tagged: false, tagLifecycleState: ['BOUND'] }, dropManager),
        ).toEqual([]);
    });
});

describe('trust filters', () => {
    it('refuses them to a masked caller, who does not receive the block', () => {
        expect(forbiddenFilters({ resaleBlocked: true }, support)).toEqual(['resaleBlocked']);
        expect(forbiddenFilters({ tampered: true }, support)).toEqual(['tampered']);
    });

    it('allows them to a caller who sees the trust block', () => {
        expect(
            forbiddenFilters({ resaleBlocked: true, tamperStatus: 'SEAL_BROKEN' }, dropManager),
        ).toEqual([]);
    });
});

describe('buyer filters', () => {
    it('refuses ownerId to a caller with no buyer access at all', () => {
        expect(forbiddenFilters({ ownerId: 'u-1' }, dropManager)).toEqual(['ownerId']);
    });

    it('refuses ownerId to a caller who only gets a masked one', () => {
        // Support sees `u-77213f…`; letting them filter on the full uuid would
        // let them enumerate one buyer's units, which is the thing masking is
        // for.
        expect(forbiddenFilters({ ownerId: 'u-1' }, support)).toEqual(['ownerId']);
    });

    it('leaves hasOwner alone', () => {
        // `claimedStatus=CLAIMED` already answers exactly this question, so
        // gating one and not the other would be theatre.
        expect(forbiddenFilters({ hasOwner: true }, dropManager)).toEqual([]);
    });
});

describe('reporting', () => {
    it('names every refused filter at once', () => {
        const refused = forbiddenFilters({ tagId: 'x', ownerId: 'u-1' }, dropManager);
        expect(refused).toEqual(expect.arrayContaining(['tagId', 'ownerId']));
    });

    it('throws a 403 naming them', () => {
        expect(() => assertFiltersPermitted({ tagId: 'x' }, dropManager)).toThrow(/tagId/);
    });

    it('passes a query using nothing gated', () => {
        expect(() =>
            assertFiltersPermitted(
                { page: 1, serialFrom: 1, serialTo: 500, claimedStatus: ['UNCLAIMED'] },
                dropManager,
            ),
        ).not.toThrow();
    });

    it('lets a system admin through untouched', () => {
        expect(
            forbiddenFilters(
                { tagId: 'x', ownerId: 'u-1', resaleBlocked: true, vendorId: 'v-1' },
                systemAdmin,
            ),
        ).toEqual([]);
    });
});

describe('the search box', () => {
    it('does not match tag UIDs for a caller who may not see them', () => {
        // Otherwise `?search=04A3…` is `?tagId=04A3…` spelled differently.
        expect(searchMayMatchTag(dropManager)).toBe(false);
    });

    it('does for one who may', () => {
        expect(searchMayMatchTag(support)).toBe(true);
    });
});
