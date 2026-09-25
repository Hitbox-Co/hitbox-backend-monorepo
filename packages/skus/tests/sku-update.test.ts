import { describe, expect, it } from '@jest/globals';
import { ClaimedStatus, TagLifecycleState } from '@hitbox/database';
import {
    assertChangesUsable,
    assertFieldsWritable,
    planSkuUpdate,
} from '../src/domain/sku-update';
import type { SkuUpdateChanges, SkuUpdateTarget } from '../src/domain/sku-update';
import { Visibility, ReadScope } from '../src/domain/sku-access';
import type { SkuAccess } from '../src/domain/sku-access';

/**
 * The rules an inventory edit has to pass.
 *
 * These are asserted against the pure planner rather than through a route,
 * because the same rules decide one unit and eight hundred — and the eight
 * hundred case is the one where a rule that only half works is discovered by a
 * warehouse rather than by a test.
 */

const NOW = new Date('2026-09-22T10:00:00.000Z');

const unit = (overrides: Partial<SkuUpdateTarget> = {}): SkuUpdateTarget => ({
    id: 'sku-1',
    skuCode: '123456780042-000014',
    serialNumber: 14,
    productId: 'product-1',
    variantId: null,
    claimedStatus: ClaimedStatus.UNCLAIMED,
    ownerId: null,
    tagId: '04A39B2C5D6E80',
    tagLifecycleState: TagLifecycleState.BOUND,
    vendorId: null,
    provisioningBatchId: null,
    vendorAuthenticatedAt: null,
    resaleBlocked: false,
    resaleBlockedReason: null,
    tamperStatus: null,
    isActive: true,
    archivedAt: null,
    ...overrides,
});

const plan = (target: SkuUpdateTarget, changes: SkuUpdateChanges) =>
    planSkuUpdate(target, changes, NOW);

/** Asserts the edit was refused, and returns the reason for inspection. */
const refusal = (target: SkuUpdateTarget, changes: SkuUpdateChanges): string => {
    const outcome = plan(target, changes);
    if (outcome.ok) throw new Error('expected a refusal, got a plan');
    return outcome.problem;
};

const patchOf = (target: SkuUpdateTarget, changes: SkuUpdateChanges) => {
    const outcome = plan(target, changes);
    if (!outcome.ok) throw new Error(`expected a plan, got: ${outcome.problem}`);
    return outcome.plan;
};

const access = (overrides: Partial<SkuAccess> = {}): SkuAccess => ({
    userId: 'admin-1',
    instance: { scope: ReadScope.GLOBAL, visibility: Visibility.FULL },
    tag: { scope: ReadScope.GLOBAL, visibility: Visibility.FULL },
    buyer: null,
    order: null,
    canSeeMoney: false,
    canManageTags: true,
    canManageUnits: true,
    organizationIds: null,
    ...overrides,
});

describe('which fields a caller may write', () => {
    it('refuses tag custody fields to a caller without nfc-tag-claim:manage', () => {
        expect(() =>
            assertFieldsWritable(
                { tagLifecycleState: TagLifecycleState.LOST, reason: 'x' },
                access({ canManageTags: false }),
            ),
        ).toThrow(/tagLifecycleState/);
    });

    it('lets that same caller edit the unit itself', () => {
        // The separation that matters: a Drop Manager archives units all day
        // and cannot touch one tag. Same reason `nfc-tag-claim` is its own
        // resource rather than a flag on this one.
        expect(() =>
            assertFieldsWritable({ isActive: false }, access({ canManageTags: false })),
        ).not.toThrow();
    });

    it('refuses unit fields to a caller holding only tag custody', () => {
        expect(() =>
            assertFieldsWritable({ resaleBlocked: true }, access({ canManageUnits: false })),
        ).toThrow(/resaleBlocked/);
    });

    it('names every refused field at once', () => {
        const thrown = (): void =>
            assertFieldsWritable(
                { vendorId: null, provisioningBatchId: null },
                access({ canManageTags: false }),
            );
        expect(thrown).toThrow(/vendorId/);
        expect(thrown).toThrow(/provisioningBatchId/);
    });
});

describe('a usable body', () => {
    it('refuses one that names no editable field', () => {
        expect(() => assertChangesUsable({})).toThrow(/Nothing to change/);
        expect(() => assertChangesUsable({ reason: 'just a note' })).toThrow(/Nothing to change/);
    });

    it.each([
        ['freezing', { flagged: true }],
        ['archiving', { archived: true }],
        ['revoking a tag', { tagLifecycleState: TagLifecycleState.REVOKED }],
        ['losing a tag', { tagLifecycleState: TagLifecycleState.LOST }],
    ])('requires a reason for %s', (_label, changes) => {
        expect(() => assertChangesUsable(changes)).toThrow(/requires a `reason`/);
        expect(() => assertChangesUsable({ ...changes, reason: 'counterfeit report #88' })).not.toThrow();
    });

    it('does not ask for a reason twice when resale is blocked', () => {
        // `resaleBlockedReason` is already the reason, on the row.
        expect(() =>
            assertChangesUsable({ resaleBlocked: true, resaleBlockedReason: 'chargeback' }),
        ).not.toThrow();
    });
});

describe('no-ops', () => {
    it('produces an empty patch when the unit is already in the requested state', () => {
        // Retrying a request that already landed has to be safe — otherwise a
        // timed-out batch cannot be re-sent.
        expect(patchOf(unit({ isActive: true }), { isActive: true }).patch).toEqual({});
    });

    it('records only the columns that actually change', () => {
        const result = patchOf(unit(), { isActive: false, tamperStatus: null });
        expect(Object.keys(result.patch)).toEqual(['isActive']);
        expect(result.before).toEqual({ isActive: true });
        expect(result.after).toEqual({ isActive: false });
    });
});

describe('archival', () => {
    it('refuses to archive a unit somebody is holding', () => {
        // Archiving hides a real object from the platform while its owner has
        // it in their hands.
        expect(refusal(unit({ claimedStatus: ClaimedStatus.CLAIMED, ownerId: 'u-1' }), {
            archived: true,
        })).toMatch(/cannot be archived/);
    });

    it('delists as it archives', () => {
        const result = patchOf(unit(), { archived: true });
        expect(result.patch).toEqual({ archivedAt: NOW, isActive: false });
    });

    it('refuses to archive and activate in one request', () => {
        expect(refusal(unit(), { archived: true, isActive: true })).toMatch(/at once/);
    });

    it('restores without re-listing', () => {
        // Un-archiving says the record is live again; whether it is for sale is
        // a separate decision the operator still makes.
        const result = patchOf(unit({ archivedAt: NOW, isActive: false }), { archived: false });
        expect(result.patch).toEqual({ archivedAt: null });
    });

    it('serialises dates in the snapshots', () => {
        const result = patchOf(unit({ archivedAt: NOW }), { archived: false });
        expect(result.before).toEqual({ archivedAt: '2026-09-22T10:00:00.000Z' });
    });
});

describe('resale blocking', () => {
    it('refuses a block with no reason anywhere', () => {
        expect(refusal(unit(), { resaleBlocked: true })).toMatch(/resaleBlockedReason/);
    });

    it('accepts a block when the row already carries a reason', () => {
        const target = unit({ resaleBlocked: false, resaleBlockedReason: 'chargeback #41' });
        expect(patchOf(target, { resaleBlocked: true }).patch).toEqual({ resaleBlocked: true });
    });

    it('clears the reason when the block is lifted', () => {
        const target = unit({ resaleBlocked: true, resaleBlockedReason: 'chargeback #41' });
        expect(patchOf(target, { resaleBlocked: false }).patch).toEqual({
            resaleBlocked: false,
            resaleBlockedReason: null,
        });
    });

    it('refuses to unblock and give a block reason in one request', () => {
        expect(
            refusal(unit({ resaleBlocked: true }), {
                resaleBlocked: false,
                resaleBlockedReason: 'still bad',
            }),
        ).toMatch(/cannot unblock/);
    });

    it('refuses a reason for a block that does not exist', () => {
        expect(refusal(unit(), { resaleBlockedReason: 'because' })).toMatch(/not resale-blocked/);
    });
});

describe('the investigation freeze', () => {
    it('freezes an unclaimed unit', () => {
        expect(patchOf(unit(), { flagged: true, reason: 'counterfeit report' }).patch).toEqual({
            claimedStatus: ClaimedStatus.FLAGGED,
        });
    });

    it('releases a held unit back to CLAIMED', () => {
        // Not "whatever it was before" — that is not recorded anywhere, and
        // guessing it would be a fabrication. `ownerId` is the column that is
        // actually authoritative about whether a unit is claimed.
        const target = unit({ claimedStatus: ClaimedStatus.FLAGGED, ownerId: 'u-1' });
        expect(patchOf(target, { flagged: false }).patch).toEqual({
            claimedStatus: ClaimedStatus.CLAIMED,
        });
    });

    it('releases an ownerless unit back to UNCLAIMED', () => {
        const target = unit({ claimedStatus: ClaimedStatus.FLAGGED, ownerId: null });
        expect(patchOf(target, { flagged: false }).patch).toEqual({
            claimedStatus: ClaimedStatus.UNCLAIMED,
        });
    });

    it('refuses to unfreeze something that was not frozen', () => {
        expect(refusal(unit(), { flagged: false })).toMatch(/not FLAGGED/);
    });

    it('refuses to touch a transfer in flight', () => {
        // A half-written ownership change belongs to the claims module;
        // freezing it from the outside would strand it.
        const target = unit({ claimedStatus: ClaimedStatus.IN_TRANSFER });
        expect(refusal(target, { flagged: true, reason: 'fraud' })).toMatch(/IN_TRANSFER/);
    });
});

describe('tag lifecycle', () => {
    it('lets an operator mark a bound tag lost', () => {
        expect(
            patchOf(unit(), { tagLifecycleState: TagLifecycleState.LOST, reason: 'chip failed' })
                .patch,
        ).toEqual({ tagLifecycleState: TagLifecycleState.LOST });
    });

    it('lets a lost tag come back', () => {
        const target = unit({ tagLifecycleState: TagLifecycleState.LOST });
        expect(patchOf(target, { tagLifecycleState: TagLifecycleState.BOUND }).patch).toEqual({
            tagLifecycleState: TagLifecycleState.BOUND,
        });
    });

    it('treats REVOKED as terminal', () => {
        // If it could be walked back, "revoked" would mean "revoked for now",
        // and the whole point of the state is that it does not.
        const target = unit({ tagLifecycleState: TagLifecycleState.REVOKED });
        expect(refusal(target, { tagLifecycleState: TagLifecycleState.BOUND })).toMatch(
            /terminal/,
        );
    });

    it('never lets an operator declare a tag ACTIVE', () => {
        // ACTIVE is reached on first claim, by the claims module. Writing it
        // here would make the column describe an intention, not the tag.
        expect(refusal(unit(), { tagLifecycleState: TagLifecycleState.ACTIVE })).toMatch(
            /cannot go BOUND → ACTIVE/,
        );
    });

    it('never lets an operator declare a tag UNPROVISIONED', () => {
        expect(refusal(unit(), { tagLifecycleState: TagLifecycleState.UNPROVISIONED })).toMatch(
            /cannot go/,
        );
    });

    it('refuses a lifecycle state on a unit with no tag', () => {
        const target = unit({ tagId: null, tagLifecycleState: TagLifecycleState.UNPROVISIONED });
        expect(
            refusal(target, { tagLifecycleState: TagLifecycleState.LOST, reason: 'x' }),
        ).toMatch(/carries no tag/);
    });

    it('refuses vendor authentication on a unit with no tag', () => {
        const target = unit({ tagId: null, tagLifecycleState: TagLifecycleState.UNPROVISIONED });
        expect(refusal(target, { vendorAuthenticated: true })).toMatch(/no tag/);
    });

    it('stamps and clears vendorAuthenticatedAt', () => {
        expect(patchOf(unit(), { vendorAuthenticated: true }).patch).toEqual({
            vendorAuthenticatedAt: NOW,
        });
        const stamped = unit({ vendorAuthenticatedAt: NOW });
        expect(patchOf(stamped, { vendorAuthenticated: false }).patch).toEqual({
            vendorAuthenticatedAt: null,
        });
    });
});

describe('variants', () => {
    it('asks the caller to verify a newly attached variant', () => {
        const result = patchOf(unit(), { variantId: 'variant-9' });
        expect(result.variantToVerify).toBe('variant-9');
    });

    it('asks nothing when the variant is being detached', () => {
        const result = patchOf(unit({ variantId: 'variant-9' }), { variantId: null });
        expect(result.variantToVerify).toBeNull();
        expect(result.patch).toEqual({ variantId: null });
    });
});
