import { OrderFulfilmentService, unshippableReason } from '../src/service/order-fulfilment.service';
import { assignByScanSchema, assignUnitSchema } from '../src/dto/order-fulfilment.dto';
import type {
    FulfilmentOrderRow,
    OrderFulfilmentRepository,
    ScannedUnitRow,
} from '../src/repository/order-fulfilment.repository';

/**
 * Scan-to-assign at packing — docs/orders/order-unit-assignment-api.md.
 * The repository is faked; the transactional swap itself is the repository's
 * job and is exercised against a real database separately.
 */

const ORG = 'org-1';
const CALLER = { userId: 'packer-1', organizationIds: [ORG] };

const PLACEHOLDER = { id: 'sku-1', skuCode: 'GRP-000001', serialNumber: 1, tagId: 'TAG-001', variantId: 'v-red-s' };

function order(over: Partial<FulfilmentOrderRow> = {}): FulfilmentOrderRow {
    return {
        id: 'order-1',
        publicCode: 'odr0abc',
        status: 'PAID',
        organizationId: ORG,
        productId: 'drop-1',
        variantId: 'v-red-s',
        skuId: 'sku-1',
        unitAssignedAt: null,
        unitAssignedById: null,
        placedAt: new Date('2026-10-14T09:00:00Z'),
        drop: { groupCode: 'GRP', name: 'Tour Tee' },
        variant: { label: 'S / Red', variantCode: 'GRP-S-RED' },
        sku: PLACEHOLDER,
        inventoryReservations: [{ id: 'res-1', skuId: 'sku-1', sku: PLACEHOLDER }],
        ...over,
    } as FulfilmentOrderRow;
}

function unit(over: Partial<ScannedUnitRow> = {}): ScannedUnitRow {
    return {
        id: 'sku-214',
        skuCode: 'GRP-000214',
        serialNumber: 214,
        tagId: 'TAG-214',
        productId: 'drop-1',
        variantId: 'v-red-s',
        isActive: true,
        archivedAt: null,
        claimedStatus: 'UNCLAIMED',
        resaleBlocked: false,
        tagLifecycleState: 'BOUND',
        ...over,
    } as ScannedUnitRow;
}

type Holder = { reason: 'SOLD' | 'HELD'; orderId: string | null; orderPublicCode: string | null; orderStatus: string | null };

function setup(opts: { order?: FulfilmentOrderRow | null; unit?: ScannedUnitRow | null; oldest?: string | null; holder?: Holder | null } = {}) {
    let current = opts.order === undefined ? order() : opts.order;
    const assignCalls: Record<string, unknown>[] = [];
    const candidateCalls: Record<string, unknown>[] = [];
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const repo = {
        findOrder: async (id: string) => (current && current.id === id ? current : null),
        findUnit: async () => (opts.unit === undefined ? unit() : opts.unit),
        unitHolder: async () => opts.holder ?? null,
        candidates: async (input: Record<string, unknown>) => {
            candidateCalls.push(input);
            return { total: 2, items: [PLACEHOLDER, { id: 'sku-214', skuCode: 'GRP-000214', serialNumber: 214, tagId: 'TAG-214', variantId: 'v-red-s' }] };
        },
        findOldestWaiting: async () => (opts.oldest === null ? null : { id: opts.oldest ?? 'order-1' }),
        queue: async () => ({ total: current ? 1 : 0, items: current ? [current] : [] }),
        assign: async (input: Record<string, unknown>) => {
            assignCalls.push(input);
            const scanned = opts.unit ?? unit();
            current = {
                ...current!,
                skuId: input.toSkuId as string,
                unitAssignedAt: input.now as Date,
                unitAssignedById: input.actorId as string,
                status: current!.status === 'PAID' ? 'PROCESSING' : current!.status,
                sku: { id: scanned.id, skuCode: scanned.skuCode, serialNumber: scanned.serialNumber, tagId: scanned.tagId, variantId: scanned.variantId },
            } as FulfilmentOrderRow;
            return { statusChanged: input.expectedStatus === 'PAID' };
        },
    } as unknown as OrderFulfilmentRepository;
    const service = new OrderFulfilmentService({
        fulfilment: repo,
        eventBus: { publish: async (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); } } as never,
        logger: { info() { }, warn() { }, error() { } } as never,
    });
    return { service, assignCalls, candidateCalls, events };
}

describe('request schemas', () => {
    it('takes exactly one of tagId / skuCode / serialNumber', () => {
        expect(assignUnitSchema.safeParse({ tagId: 'T' }).success).toBe(true);
        expect(assignUnitSchema.safeParse({ serialNumber: '214' }).success).toBe(true);
        expect(assignUnitSchema.safeParse({}).success).toBe(false);
        expect(assignUnitSchema.safeParse({ tagId: 'T', skuCode: 'S' }).success).toBe(false);
    });

    it('scan-first refuses a bare serial number (ambiguous without an order)', () => {
        expect(assignByScanSchema.safeParse({ serialNumber: 214 }).success).toBe(false);
        expect(assignByScanSchema.safeParse({ tagId: 'TAG-214' }).success).toBe(true);
    });
});

describe('scan-to-assign', () => {
    it('swaps the placeholder for the scanned unit and confirms it', async () => {
        const { service, assignCalls, events } = setup();
        const result = await service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER);

        expect(assignCalls[0]).toMatchObject({
            orderId: 'order-1',
            reservationId: 'res-1',
            fromSkuId: 'sku-1',
            toSkuId: 'sku-214',
            expectedStatus: 'PAID',
            actorId: 'packer-1',
        });
        expect(result).toMatchObject({
            unitState: 'ASSIGNED',
            status: 'PROCESSING',
            readyToShip: true,
            unit: { skuCode: 'GRP-000214', tagId: 'TAG-214' },
        });
        expect(events.map((e) => e.name)).toEqual(['orders.order.unit-assigned', 'orders.order.status-changed']);
        expect(events[0]!.payload).toMatchObject({ previousSkuId: 'sku-1', replaced: false });
    });

    it('scanning the placeholder itself just confirms it', async () => {
        const { service, assignCalls } = setup({ unit: unit({ id: 'sku-1', skuCode: 'GRP-000001', tagId: 'TAG-001' }) });
        await service.assign('order-1', { tagId: 'TAG-001', replace: false }, CALLER);
        expect(assignCalls[0]).toMatchObject({ fromSkuId: 'sku-1', toSkuId: 'sku-1' });
    });

    it('refuses the wrong variant (Blue M picked for a Red S order)', async () => {
        const { service, assignCalls } = setup({ unit: unit({ variantId: 'v-blue-m' }) });
        await expect(service.assign('order-1', { tagId: 'X', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_WRONG_ITEM',
        });
        expect(assignCalls).toHaveLength(0);
    });

    it('refuses a unit from another drop', async () => {
        const { service } = setup({ unit: unit({ productId: 'drop-2' }) });
        await expect(service.assign('order-1', { tagId: 'X', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_WRONG_ITEM',
        });
    });

    it.each([
        ['archived', { archivedAt: new Date() }],
        ['deactivated', { isActive: false }],
        ['claimed', { claimedStatus: 'CLAIMED' }],
        ['blocked', { resaleBlocked: true }],
        ['untagged', { tagId: null }],
        ['tag lost', { tagLifecycleState: 'LOST' }],
    ])('refuses a %s unit', async (_label, over) => {
        const { service } = setup({ unit: unit(over as Partial<ScannedUnitRow>) });
        await expect(service.assign('order-1', { skuCode: 'GRP-000214', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_UNIT_UNAVAILABLE',
        });
    });

    it('404s an unknown scan', async () => {
        const { service } = setup({ unit: null });
        await expect(service.assign('order-1', { tagId: 'NOPE', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_UNIT_NOT_FOUND',
        });
    });

    it('refuses a second, different scan without replace', async () => {
        const assigned = order({ status: 'PROCESSING', unitAssignedAt: new Date(), skuId: 'sku-9', sku: { ...PLACEHOLDER, id: 'sku-9', skuCode: 'GRP-000009' } });
        const { service } = setup({ order: assigned });
        await expect(service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_UNIT_ALREADY_ASSIGNED',
        });
    });

    it('replaces with replace: true', async () => {
        const assigned = order({ status: 'PROCESSING', unitAssignedAt: new Date(), skuId: 'sku-9' });
        const { service, assignCalls, events } = setup({ order: assigned });
        await service.assign('order-1', { tagId: 'TAG-214', replace: true }, CALLER);
        expect(assignCalls[0]).toMatchObject({ toSkuId: 'sku-214', expectedStatus: 'PROCESSING', expectedOrderSkuId: 'sku-9' });
        expect(events.map((e) => e.name)).toEqual(['orders.order.unit-assigned']); // no status change
    });

    it('a repeated scan of the confirmed unit is a no-op', async () => {
        const assigned = order({ status: 'PROCESSING', unitAssignedAt: new Date(), skuId: 'sku-214' });
        const { service, assignCalls } = setup({ order: assigned });
        await service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER);
        expect(assignCalls).toHaveLength(0);
    });

    it.each(['PENDING_PAYMENT', 'SHIPPED', 'CANCELLED', 'REFUNDED'])('refuses an order that is %s', async (status) => {
        const { service } = setup({ order: order({ status: status as never }) });
        await expect(service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_NOT_ASSIGNABLE',
        });
    });

    it('hides orders of other organizations as 404', async () => {
        const { service } = setup({ order: order({ organizationId: 'org-other' }) });
        await expect(service.get('order-1', CALLER)).rejects.toMatchObject({ code: 'ORDERS_NOT_FOUND' });
    });
});

describe('scan first', () => {
    it('assigns the scanned unit to the oldest waiting order of its variant', async () => {
        const { service, assignCalls } = setup();
        const result = await service.assignByScan({ tagId: 'TAG-214' }, CALLER);
        expect(assignCalls[0]).toMatchObject({ orderId: 'order-1', toSkuId: 'sku-214' });
        expect(result.unitState).toBe('ASSIGNED');
    });

    it('says so when nobody is waiting for that item', async () => {
        const { service } = setup({ oldest: null });
        await expect(service.assignByScan({ tagId: 'TAG-214' }, CALLER)).rejects.toMatchObject({
            code: 'ORDERS_NO_WAITING_ORDER',
        });
    });
});

describe('fulfilment view', () => {
    it('shows a paid, unscanned order as PROVISIONAL with the placeholder unit', async () => {
        const { service } = setup();
        expect(await service.get('order-1', CALLER)).toMatchObject({
            unitState: 'PROVISIONAL',
            readyToShip: false,
            unit: { skuCode: 'GRP-000001' },
        });
    });

    it('unshippableReason accepts a clean BOUND unit', () => {
        expect(unshippableReason(unit())).toBeNull();
    });
});

describe('a unit that is already sold or held', () => {
    it('says which order has it, and never starts the swap', async () => {
        const { service, assignCalls } = setup({
            holder: { reason: 'SOLD', orderId: 'order-9', orderPublicCode: 'odr0zzz', orderStatus: 'SHIPPED' },
        });
        const error = await service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER).catch((e) => e);
        expect(error.code).toBe('ORDERS_UNIT_UNAVAILABLE');
        expect(error.message).toBe('GRP-000214 is already sold: it is the unit of order odr0zzz (SHIPPED).');
        expect(error.details).toMatchObject({ reason: 'SOLD', orderPublicCode: 'odr0zzz', orderStatus: 'SHIPPED' });
        expect(assignCalls).toHaveLength(0);
    });

    it('names a live hold too', async () => {
        const { service } = setup({
            holder: { reason: 'HELD', orderId: 'order-8', orderPublicCode: 'odr0yyy', orderStatus: 'PENDING_PAYMENT' },
        });
        const error = await service.assign('order-1', { tagId: 'TAG-214', replace: false }, CALLER).catch((e) => e);
        expect(error.message).toBe('GRP-000214 is held for order odr0yyy (PENDING_PAYMENT).');
    });

    it('does not ask about the unit already held for this order', async () => {
        const { service, assignCalls } = setup({
            unit: unit({ id: 'sku-1', skuCode: 'GRP-000001', tagId: 'TAG-001' }),
            holder: { reason: 'SOLD', orderId: 'order-1', orderPublicCode: 'odr0abc', orderStatus: 'PAID' },
        });
        await service.assign('order-1', { tagId: 'TAG-001', replace: false }, CALLER);
        expect(assignCalls).toHaveLength(1);
    });
});

describe('GET /admin/orders/:orderId/unit/candidates', () => {
    it('asks for this drop and variant, keeps the held unit in, and flags it', async () => {
        const { service, candidateCalls } = setup();
        const result = await service.candidates('order-1', { page: 2, limit: 10, search: '214' }, CALLER);
        expect(candidateCalls[0]).toMatchObject({
            productId: 'drop-1', variantId: 'v-red-s', heldSkuId: 'sku-1', search: '214', skip: 10, take: 10,
        });
        expect(result.items.map((i) => [i.skuCode, i.heldForThisOrder])).toEqual([
            ['GRP-000001', true],
            ['GRP-000214', false],
        ]);
    });

    it('refuses an order that cannot take a unit, and hides other organizations', async () => {
        const shipped = setup({ order: order({ status: 'SHIPPED' }) });
        await expect(shipped.service.candidates('order-1', { page: 1, limit: 20 }, CALLER))
            .rejects.toMatchObject({ code: 'ORDERS_NOT_ASSIGNABLE' });
        const noHold = setup({ order: order({ inventoryReservations: [] }) });
        await expect(noHold.service.candidates('order-1', { page: 1, limit: 20 }, CALLER))
            .rejects.toMatchObject({ code: 'ORDERS_NOT_ASSIGNABLE' });
        const elsewhere = setup({ order: order({ organizationId: 'org-2' }) });
        await expect(elsewhere.service.candidates('order-1', { page: 1, limit: 20 }, CALLER))
            .rejects.toMatchObject({ code: 'ORDERS_NOT_FOUND' });
    });
});
