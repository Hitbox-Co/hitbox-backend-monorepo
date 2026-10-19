import { ApprovalAuthority, ApprovalStatus } from '@hitbox/database';
import { ReleaseGateAdapter } from '../src/domain/release-gate.adapter';

/**
 * The gate that decides whether a drop may be published AND whether its
 * edition may be minted. One condition serves both: the owner has approved it,
 * or there is no owner to ask.
 */

const OWNED = { artistId: 'artist-kaze', organizationId: null };
const UNOWNED = { artistId: null, organizationId: null };

/** Minimal stand-in for the repository — only the two reads the gate makes. */
function gateWith(options: {
    latest?: Record<string, unknown> | null;
    ownership?: { artistId: string | null; organizationId: string | null } | null;
}) {
    const repository = {
        findLatestForProduct: async () => options.latest ?? null,
        findOwnership: async () =>
            options.ownership === undefined ? OWNED : options.ownership,
    };
    return new ReleaseGateAdapter(repository as never);
}

const review = (status: ApprovalStatus, extra: Record<string, unknown> = {}) => ({
    id: 'ap-1',
    version: 2,
    status,
    authority: ApprovalAuthority.ARTIST,
    comment: null,
    ...extra,
});

describe('requiresApproval', () => {
    it('is false only when the drop names neither an artist nor an organization', () => {
        const gate = gateWith({});
        expect(gate.requiresApproval(UNOWNED)).toBe(false);
    });

    it('is true for an artist-owned drop', () => {
        expect(gateWith({}).requiresApproval(OWNED)).toBe(true);
    });

    it('is true for an organization-owned drop', () => {
        expect(
            gateWith({}).requiresApproval({ artistId: null, organizationId: 'org-lumen' }),
        ).toBe(true);
    });
});

describe('describeLatest — an approved drop is cleared', () => {
    it('clears a drop whose latest review is APPROVED', async () => {
        const verdict = await gateWith({ latest: review(ApprovalStatus.APPROVED) })
            .describeLatest('d-1');

        expect(verdict.cleared).toBe(true);
        expect(verdict.reason).toBeNull();
        expect(verdict.version).toBe(2);
    });
});

describe('describeLatest — everything else is refused, with a reason', () => {
    it('refuses a rejected drop and quotes the rejection note', async () => {
        const verdict = await gateWith({
            latest: review(ApprovalStatus.REJECTED, { comment: 'Sample not cleared.' }),
        }).describeLatest('d-1');

        expect(verdict.cleared).toBe(false);
        expect(verdict.reason).toMatch(/rejected/i);
        expect(verdict.reason).toMatch(/Sample not cleared/);
    });

    it('refuses a drop still awaiting its owner', async () => {
        const verdict = await gateWith({ latest: review(ApprovalStatus.PENDING) })
            .describeLatest('d-1');

        expect(verdict.cleared).toBe(false);
        expect(verdict.reason).toMatch(/awaiting a decision/i);
    });

    it('refuses an owned drop that was never submitted', async () => {
        const verdict = await gateWith({ latest: null, ownership: OWNED })
            .describeLatest('d-1');

        expect(verdict.cleared).toBe(false);
        expect(verdict.approvalRequired).toBe(true);
        expect(verdict.reason).toMatch(/never been submitted/i);
    });

    it('refuses a drop that does not exist', async () => {
        const verdict = await gateWith({ latest: null, ownership: null })
            .describeLatest('d-nope');

        expect(verdict.cleared).toBe(false);
        expect(verdict.reason).toMatch(/does not exist/i);
    });
});

describe('describeLatest — an unowned drop needs no approval at all', () => {
    it('clears it with NO review row, so it is mintable immediately', async () => {
        // The case that lets an administrator mint HitBox's own edition
        // without first walking it through a review that would auto-pass.
        const verdict = await gateWith({ latest: null, ownership: UNOWNED })
            .describeLatest('d-1');

        expect(verdict.cleared).toBe(true);
        expect(verdict.approvalRequired).toBe(false);
        expect(verdict.authority).toBe(ApprovalAuthority.NONE);
        expect(verdict.approvalId).toBeNull();
    });

    it('still clears it once the auto-pass review exists', async () => {
        const verdict = await gateWith({
            latest: review(ApprovalStatus.APPROVED, { authority: ApprovalAuthority.NONE }),
        }).describeLatest('d-1');

        expect(verdict.cleared).toBe(true);
        expect(verdict.approvalRequired).toBe(false);
    });

    it('does NOT clear an owned drop just because no review exists', async () => {
        // The mistake this guards against: treating "no review" as "no
        // approval needed" for every drop rather than only for unowned ones.
        const verdict = await gateWith({ latest: null, ownership: OWNED })
            .describeLatest('d-1');
        expect(verdict.cleared).toBe(false);
    });
});
