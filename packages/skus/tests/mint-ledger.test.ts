import { SkuService } from '../src/service/sku.service';
import { NOOP_SKU_AUDIT } from '../src/domain/interfaces/sku-audit.interface';
import type { SkuAccess } from '../src/domain/sku-access';
import type { ISkuMintLedger, MintedUnitRef } from '../src/domain/interfaces/mint-ledger.interface';

/**
 * Every minted unit is born with its MINT ledger record, written with the SAME
 * transaction client that inserted the unit — so the two commit or roll back
 * together.
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

const TX = { __tx: 'the-minting-transaction' };

function units(n: number): MintedUnitRef[] {
    return Array.from({ length: n }, (_, i) => ({
        skuId: `sku-${i + 1}`,
        skuCode: `841700000000-${String(i + 1).padStart(6, '0')}`,
        serialNumber: i + 1,
        tagId: null,
        groupCode: '841700000000',
        createdAt: new Date('2026-10-12T10:00:00Z'),
    }));
}

function build(ledger: ISkuMintLedger | undefined) {
    const state = { committed: false, rolledBack: false };
    const repository = {
        findProduct: async () => ({ id: 'd-1', groupCode: '841700000000', totalSupply: 500, organizationId: null }),
        variantBelongsTo: async () => true,
        findBoundTags: async () => [],
        countForProduct: async () => 0,
        // Stands in for prisma.$transaction: commit on success, roll back on throw.
        runInTransaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
            try {
                const result = await work(TX);
                state.committed = true;
                return result;
            } catch (error) {
                state.rolledBack = true;
                throw error;
            }
        },
        mintWithin: async (_tx: unknown, spec: { count: number }) => ({
            outcome: {
                minted: spec.count,
                firstSerial: 1,
                lastSerial: spec.count,
                skuCodes: units(spec.count).map((u) => u.skuCode),
                tagsBound: 0,
            },
            units: units(spec.count),
        }),
    };
    const service = new SkuService({
        skus: repository as never,
        eventBus: { publish: async () => { }, subscribe: () => ({ unsubscribe() { } }) } as never,
        audit: NOOP_SKU_AUDIT,
        logger: { info() { }, warn() { }, error() { }, debug() { } } as never,
        mintLedger: ledger,
    });
    return { service, state };
}

describe('MINT ledger record on SKU creation', () => {
    it('writes one MINT record per unit, inside the minting transaction, attributed to the minter', async () => {
        const calls: { tx: unknown; units: MintedUnitRef[]; actorId: string | null }[] = [];
        const ledger: ISkuMintLedger = {
            recordMintWithin: async (tx, input) => {
                calls.push({ tx, ...input });
            },
        };
        const { service, state } = build(ledger);

        const result = await service.mint(access, 'd-1', { count: 3 } as never);

        expect(result).toMatchObject({ minted: 3 });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.tx).toBe(TX); // same transaction client as the unit insert
        expect(calls[0]!.units.map((u) => u.skuId)).toEqual(['sku-1', 'sku-2', 'sku-3']);
        expect(calls[0]!.actorId).toBe('u-admin');
        expect(state.committed).toBe(true);
    });

    it('rolls the units back when the ledger write fails', async () => {
        const ledger: ISkuMintLedger = {
            recordMintWithin: async () => {
                throw new Error('ledger insert failed');
            },
        };
        const { service, state } = build(ledger);

        await expect(service.mint(access, 'd-1', { count: 2 } as never)).rejects.toThrow('ledger insert failed');
        expect(state.rolledBack).toBe(true);
        expect(state.committed).toBe(false);
    });

    it('inline mints (drop creation) are recorded too, with no actor', async () => {
        const calls: { actorId: string | null; count: number }[] = [];
        const { service } = build({
            recordMintWithin: async (_tx, input) => {
                calls.push({ actorId: input.actorId, count: input.units.length });
            },
        });

        await service.mintWithin(TX as never, { productId: 'd-1', groupCode: '841700000000', totalSupply: 0, count: 5 });

        expect(calls).toEqual([{ actorId: null, count: 5 }]);
    });
});
