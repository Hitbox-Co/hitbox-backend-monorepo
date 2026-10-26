import { SkuService } from '../src/service/sku.service';
import { NOOP_SKU_AUDIT } from '../src/domain/interfaces/sku-audit.interface';

/**
 * The supply intake mints through `mintWithin` (inside its accept
 * transaction) after `assertMintAllowed`. Both must hold the same lines the
 * admin mint endpoint holds: release approval, variant rules, and caps — the
 * variant cap enforced inside the transaction, not just pre-checked.
 */

const TX = { __tx: 'accept-transaction' };

function build(options: {
    variant?: { variantCode: string; totalSupply: number | null; existing: number } | null;
    released?: boolean;
    policy?: { ok: true } | { ok: false; code: string; message: string; details?: unknown };
} = {}) {
    const mintWithin = jest.fn(async (_tx: unknown, spec: { count: number }) => ({
        outcome: { minted: spec.count, firstSerial: 1, lastSerial: spec.count, skuCodes: [], tagsBound: 0 },
        units: [],
    }));
    const repository = {
        countForProduct: async () => 0,
        variantCapWithin: jest.fn(async () => options.variant ?? null),
        mintWithin,
    };
    const service = new SkuService({
        skus: repository as never,
        eventBus: { publish: async () => { }, subscribe: () => ({ unsubscribe() { } }) } as never,
        audit: NOOP_SKU_AUDIT,
        logger: { info() { }, warn() { }, error() { }, debug() { } } as never,
        releaseGate: {
            describeLatest: async () =>
                options.released === false
                    ? { cleared: false, reason: 'Awaiting artist approval.', approvalId: 'a-1', version: 2, status: 'PENDING' }
                    : { cleared: true },
        } as never,
        variantPolicy: { checkMint: jest.fn(async () => options.policy ?? { ok: true }) } as never,
    });
    return { service, repository, mintWithin };
}

const spec = (count: number, variantId: string | null = 'v-red-s') => ({
    productId: 'd-1',
    groupCode: 'TEE',
    totalSupply: 0,
    count,
    variantId,
    nfcTagIds: Array.from({ length: count }, (_, i) => `chip-${i}`),
});

describe('variant cap inside the mint transaction', () => {
    it('refuses a mint that would pass the variant cap, before inserting anything', async () => {
        const { service, mintWithin, repository } = build({
            variant: { variantCode: 'TEE-RED-S', totalSupply: 100, existing: 95 },
        });
        await expect(service.mintWithin(TX as never, spec(6))).rejects.toMatchObject({
            code: 'SKUS_VARIANT_SUPPLY_EXCEEDED',
            details: expect.objectContaining({ variantTotalSupply: 100, minted: 95, requested: 6 }),
        });
        expect(repository.variantCapWithin).toHaveBeenCalledWith(TX, 'v-red-s');
        expect(mintWithin).not.toHaveBeenCalled();
    });

    it('allows exactly up to the cap', async () => {
        const { service, mintWithin } = build({
            variant: { variantCode: 'TEE-RED-S', totalSupply: 100, existing: 95 },
        });
        await expect(service.mintWithin(TX as never, spec(5))).resolves.toMatchObject({ minted: 5 });
        expect(mintWithin).toHaveBeenCalled();
    });

    it('ignores an uncapped variant and a unit with no variant', async () => {
        const uncapped = build({ variant: { variantCode: 'X', totalSupply: null, existing: 999 } });
        await expect(uncapped.service.mintWithin(TX as never, spec(10))).resolves.toBeDefined();
        const none = build();
        await expect(none.service.mintWithin(TX as never, spec(10, null))).resolves.toBeDefined();
        expect(none.repository.variantCapWithin).not.toHaveBeenCalled();
    });
});

describe('assertMintAllowed', () => {
    const groups = [{ variantId: 'v-red-s', count: 3 }, { variantId: 'v-red-m', count: 2 }];

    it('refuses a drop that has not cleared release approval', async () => {
        const { service } = build({ released: false });
        await expect(service.assertMintAllowed({ productId: 'd-1', groups })).rejects.toMatchObject({
            code: 'SKUS_NOT_APPROVED',
        });
    });

    it('surfaces the variant policy verdict as a 409 naming the group', async () => {
        const { service } = build({
            policy: { ok: false, code: 'PRODUCTS_VARIANT_SUPPLY_EXCEEDED', message: 'cap', details: { minted: 98 } },
        });
        await expect(service.assertMintAllowed({ productId: 'd-1', groups })).rejects.toMatchObject({
            statusCode: 409,
            code: 'PRODUCTS_VARIANT_SUPPLY_EXCEEDED',
            details: { minted: 98, variantId: 'v-red-s', requested: 3 },
        });
    });

    it('passes when released and every group is within the rules', async () => {
        const { service } = build();
        await expect(service.assertMintAllowed({ productId: 'd-1', groups })).resolves.toBeUndefined();
    });
});
