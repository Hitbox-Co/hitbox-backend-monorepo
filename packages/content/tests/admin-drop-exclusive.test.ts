import pino from 'pino';
import { AdminDropContentService, assertUnitsSelectable } from '../src/service/admin-drop-content.service';
import type { LockedUnit } from '../src/repository/drop-content.repository';

/**
 * HitBox choosing which specific SKUs open a drop's exclusive content — only
 * while each SKU is unclaimed with no owner.
 */

const DROP = 'drop-1';
const TIER = 'tier-x';
const actor = { userId: 'admin-1', roleName: 'HITBOX_SYSTEM_ADMIN' };

function unit(id: string, serialNumber: number, over: Partial<LockedUnit> = {}): LockedUnit {
    return { id, productId: DROP, serialNumber, claimedStatus: 'UNCLAIMED', owned: false, ...over };
}

function tierRow(serials: number[], over: Record<string, unknown> = {}) {
    return {
        id: TIER, publicCode: null, name: 'Signed video', description: null, productId: DROP,
        accessType: 'SKU_EXCLUSIVE', isActive: true, archivedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
        moderationLockedAt: null, moderationReason: null, moderatedById: null,
        contentBundleItems: [],
        eligibleSerials: serials.map((serialNumber) => ({ serialNumber })),
        ...over,
    };
}

function build(options: { units: LockedUnit[]; serials?: number[]; tier?: Record<string, unknown> }) {
    const state = { serials: new Set(options.serials ?? [1]) };
    const audit = { record: jest.fn(async () => { }) };
    const drops = {
        findDrop: async (id: string) => (id === DROP
            ? { id: DROP, publicCode: null, name: 'Tee', totalSupply: 100, released: true, archived: false }
            : null),
        findForDrop: async (_d: string, b: string) => (b === TIER
            ? tierRow([...state.serials].sort((a, z) => a - z), options.tier)
            : null),
        listForDrop: async () => [tierRow([...state.serials])],
        changeExclusiveUnits: jest.fn(async (input: any) => {
            const locked = options.units.filter((u) => input.skuIds.includes(u.id));
            input.check(locked); // runs on the locked rows; throwing aborts
            let changed = 0;
            for (const u of locked) {
                if (input.mode === 'add' && !state.serials.has(u.serialNumber)) { state.serials.add(u.serialNumber); changed++; }
                if (input.mode === 'remove' && state.serials.delete(u.serialNumber)) changed++;
            }
            return { serials: locked.map((u) => u.serialNumber), changed };
        }),
    };
    const service = new AdminDropContentService({
        drops: drops as never,
        audit: audit as never,
        logger: pino({ level: 'silent' }),
    });
    return { service, drops, audit, state };
}

describe('admin selects exclusive SKUs', () => {
    it('adds an unclaimed SKU by its serial, and audits it', async () => {
        const { service, audit } = build({ units: [unit('sku-42', 42)] });
        const result = await service.addUnits(actor, DROP, TIER, ['sku-42']);

        expect(result).toMatchObject({ serialNumbers: [1, 42], changed: 1 });
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'content.drop-exclusive.units-add',
            beforeState: { serialNumbers: [1] },
            afterState: { serialNumbers: [1, 42] },
        }));
    });

    it('is idempotent: adding an already-listed SKU changes nothing', async () => {
        const { service } = build({ units: [unit('sku-1', 1)], serials: [1] });
        await expect(service.addUnits(actor, DROP, TIER, ['sku-1'])).resolves.toMatchObject({ changed: 0 });
    });

    it('refuses a claimed SKU — for adding and for removing', async () => {
        const claimed = unit('sku-7', 7, { claimedStatus: 'CLAIMED', owned: true });
        const add = build({ units: [claimed] });
        await expect(add.service.addUnits(actor, DROP, TIER, ['sku-7'])).rejects.toMatchObject({
            statusCode: 409,
            code: 'DROP_CONTENT_UNIT_CLAIMED',
            details: { units: [expect.objectContaining({ skuId: 'sku-7', serialNumber: 7 })] },
        });

        const remove = build({ units: [claimed], serials: [1, 7] });
        await expect(remove.service.removeUnits(actor, DROP, TIER, ['sku-7'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_UNIT_CLAIMED',
        });
        expect(remove.state.serials.has(7)).toBe(true);
    });

    it('treats a sold-but-not-yet-tapped SKU (owner set) as settled too', async () => {
        const { service } = build({ units: [unit('sku-9', 9, { owned: true })] });
        await expect(service.addUnits(actor, DROP, TIER, ['sku-9'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_UNIT_CLAIMED',
        });
    });

    it('is all-or-nothing: one claimed SKU in the request blocks the others', async () => {
        const { service, state } = build({
            units: [unit('sku-2', 2), unit('sku-3', 3, { claimedStatus: 'IN_TRANSFER' })],
        });
        await expect(service.addUnits(actor, DROP, TIER, ['sku-2', 'sku-3'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_UNIT_CLAIMED',
        });
        expect(state.serials.has(2)).toBe(false);
    });

    it('removes an unclaimed SKU', async () => {
        const { service } = build({ units: [unit('sku-5', 5)], serials: [1, 5] });
        await expect(service.removeUnits(actor, DROP, TIER, ['sku-5'])).resolves.toMatchObject({
            serialNumbers: [1],
            changed: 1,
        });
    });

    it('will not empty an exclusive tier', async () => {
        const { service } = build({ units: [unit('sku-1', 1)], serials: [1] });
        await expect(service.removeUnits(actor, DROP, TIER, ['sku-1'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_SERIALS_INVALID',
        });
    });

    it('refuses the regular tier and a removed tier', async () => {
        const regular = build({ units: [unit('sku-1', 1)], tier: { accessType: 'OWNER_ONLY' } });
        await expect(regular.service.addUnits(actor, DROP, TIER, ['sku-1'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_NOT_EXCLUSIVE',
        });
        const removed = build({ units: [unit('sku-1', 1)], tier: { archivedAt: new Date() } });
        await expect(removed.service.addUnits(actor, DROP, TIER, ['sku-1'])).rejects.toMatchObject({
            code: 'DROP_CONTENT_ARCHIVED',
        });
    });
});

describe('assertUnitsSelectable', () => {
    it('reports SKUs that are missing or belong to another drop', () => {
        expect(() =>
            assertUnitsSelectable([unit('a', 1), unit('b', 2, { productId: 'other' })], ['a', 'b', 'c'], DROP),
        ).toThrow(expect.objectContaining({
            code: 'DROP_CONTENT_UNIT_NOT_IN_DROP',
            details: { skuIds: ['b', 'c'] },
        }));
    });

    it('passes unclaimed, unowned units of the drop', () => {
        expect(() => assertUnitsSelectable([unit('a', 1)], ['a'], DROP)).not.toThrow();
    });
});
