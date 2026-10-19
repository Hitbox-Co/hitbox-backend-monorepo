import { SkuService } from '../src/service/sku.service';
import { SKUS_ERROR_CODES } from '../src/constants/skus.constant';
import { NOOP_SKU_AUDIT } from '../src/domain/interfaces/sku-audit.interface';
import type { SkuAccess } from '../src/domain/sku-access';
import type { ISkuReleaseGate, SkuReleaseVerdict } from '../src/domain/interfaces/release-gate.interface';

/**
 * Minting waits for the drop's owner to approve it.
 *
 * A serialized unit is a claim about a physical object. Creating one for a
 * drop the artist may yet reject produces inventory referring to something
 * nobody will ship, which someone then reconciles away by hand.
 */

const access: SkuAccess = {
    userId: 'u-admin',
    instance: { scope: 'GLOBAL', visibility: 'FULL' },
    tag: null,
    buyer: null,
    order: null,
    canSeeMoney: false,
    canManageTags: false,
    canManageUnits: true,
    organizationIds: null,
};

const verdict = (over: Partial<SkuReleaseVerdict>): SkuReleaseVerdict => ({
    cleared: false,
    approvalRequired: true,
    reason: null,
    approvalId: null,
    version: null,
    status: null,
    authority: null,
    ...over,
});

/** A service whose only wired dependency is the gate; nothing else is reached. */
function serviceWith(gate: ISkuReleaseGate | undefined) {
    const repository = {
        // The product lookup that runs before the gate.
        findProduct: async () => ({
            id: 'd-1',
            groupCode: '8417',
            totalSupply: 500,
            organizationId: null,
        }),
        // Reached only once the gate has passed — which is what the
        // "proceeds" cases below assert by the error they get instead.
        variantBelongsTo: async () => true,
        findBoundTags: async () => [],
    };
    return new SkuService({
        skus: repository as never,
        eventBus: { publish: async () => { }, subscribe: () => ({ unsubscribe() { } }) } as never,
        audit: NOOP_SKU_AUDIT,
        logger: { info() { }, warn() { }, error() { }, debug() { } } as never,
        releaseGate: gate,
    });
}

const mint = (gate: ISkuReleaseGate | undefined) =>
    serviceWith(gate).mint(access, 'd-1', { count: 10 } as never);

describe('minting is refused until the drop is cleared', () => {
    it('refuses when the drop was never submitted', async () => {
        const gate = {
            describeLatest: async () =>
                verdict({ reason: 'This drop has never been submitted for review.' }),
        };
        await expect(mint(gate)).rejects.toMatchObject({
            code: SKUS_ERROR_CODES.NOT_APPROVED,
            statusCode: 409,
        });
    });

    it('refuses when the review is still pending', async () => {
        const gate = {
            describeLatest: async () =>
                verdict({ status: 'PENDING', reason: 'Review version 1 is still awaiting a decision.' }),
        };
        await expect(mint(gate)).rejects.toThrow(/awaiting a decision/i);
    });

    it('refuses when the drop was REJECTED', async () => {
        // The case the rule exists for: no point holding units for a drop
        // that will never ship.
        const gate = {
            describeLatest: async () =>
                verdict({ status: 'REJECTED', reason: 'Review version 1 was rejected: "Art not cleared."' }),
        };
        await expect(mint(gate)).rejects.toThrow(/rejected/i);
    });

    it('carries the review details so a console can link to it', async () => {
        const gate = {
            describeLatest: async () =>
                verdict({ approvalId: 'ap-9', version: 3, status: 'REJECTED', reason: 'no' }),
        };
        await expect(mint(gate)).rejects.toMatchObject({
            details: { approvalId: 'ap-9', version: 3, status: 'REJECTED' },
        });
    });
});

describe('minting proceeds once the drop is cleared', () => {
    it('passes the gate when the owner has approved it', async () => {
        const gate = {
            describeLatest: async () =>
                verdict({ cleared: true, status: 'APPROVED', approvalId: 'ap-1', version: 1 }),
        };
        // It gets past the gate and fails later on the stubbed repository —
        // which is the proof: the refusal is no longer NOT_APPROVED.
        await expect(mint(gate)).rejects.not.toMatchObject({
            code: SKUS_ERROR_CODES.NOT_APPROVED,
        });
    });

    it('passes for an unowned drop that needs no approval at all', async () => {
        // HitBox's own drop: no artist, no organization, nobody to ask.
        const gate = {
            describeLatest: async () =>
                verdict({ cleared: true, approvalRequired: false, authority: 'NONE' }),
        };
        await expect(mint(gate)).rejects.not.toMatchObject({
            code: SKUS_ERROR_CODES.NOT_APPROVED,
        });
    });

    it('does not block when no gate is wired in', async () => {
        // The gate is an added constraint on a deployment running the review
        // workflow, not the authority on who may mint.
        await expect(mint(undefined)).rejects.not.toMatchObject({
            code: SKUS_ERROR_CODES.NOT_APPROVED,
        });
    });
});
