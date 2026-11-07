import { SkuRepository } from '../src/repository/sku.repository';

/**
 * Minting a unit from registered chips must also move each chip to BOUND, or
 * NFC verification (which only accepts BOUND / ACTIVE chips) would refuse every
 * real tap.
 */

function fakeTx() {
    return {
        sku: {
            findFirst: jest.fn(async () => ({ serialNumber: 4 })),
            createMany: jest.fn(async () => ({ count: 0 })),
        },
        nfcTag: { updateMany: jest.fn(async () => ({ count: 0 })) },
    };
}

const spec = (nfcTagIds?: string[]) => ({
    productId: 'drop-1',
    groupCode: 'TEE',
    totalSupply: 0,
    count: 2,
    ...(nfcTagIds ? { nfcTagIds } : {}),
});

describe('mintWithin binds the chips it embeds', () => {
    it('moves only UNPROVISIONED chips to BOUND, in one statement', async () => {
        const tx = fakeTx();
        const repo = new SkuRepository({} as never);

        await repo.mintWithin(tx as never, spec(['chip-a', 'chip-b']));

        expect(tx.nfcTag.updateMany).toHaveBeenCalledTimes(1);
        const call = (tx.nfcTag.updateMany.mock.calls as unknown as [any][])[0]![0];
        expect(call.where).toEqual({ id: { in: ['chip-a', 'chip-b'] }, lifecycleState: 'UNPROVISIONED' });
        expect(call.data.lifecycleState).toBe('BOUND');
        expect(call.data.boundAt).toBeInstanceOf(Date);
    });

    it('sets the unit to BOUND and points it at its chip', async () => {
        const tx = fakeTx();
        const repo = new SkuRepository({} as never);

        await repo.mintWithin(tx as never, spec(['chip-a', 'chip-b']));

        const rows = (tx.sku.createMany.mock.calls as unknown as [any][])[0]![0].data;
        expect(rows.map((r: any) => r.currentNfcTagId)).toEqual(['chip-a', 'chip-b']);
        expect(rows.every((r: any) => r.tagLifecycleState === 'BOUND')).toBe(true);
    });

    it('touches no chip when the mint has none', async () => {
        const tx = fakeTx();
        const repo = new SkuRepository({} as never);

        await repo.mintWithin(tx as never, spec());

        expect(tx.nfcTag.updateMany).not.toHaveBeenCalled();
    });
});
