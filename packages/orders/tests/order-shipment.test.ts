import { AppError } from '@hitbox/shared';
import { recordShipmentSchema, replaceShipmentSchema } from '../src/dto/order-shipment.dto';
import { OrderService } from '../src/service/order.service';
import { OrderShipmentService } from '../src/service/order-shipment.service';

/**
 * Shipments, tracking and the buyer view — docs/orders/order-history-and-shipments.md.
 * Repositories are faked; the locked transactions are exercised against a
 * real database separately.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const ADMIN = { userId: 'ops-1', organizationIds: null };

describe('recordShipmentSchema', () => {
    const base = { carrierName: 'Delhivery', trackingNumber: '1490000000123' };

    it('strips the spaces carriers print in tracking numbers', () => {
        expect(recordShipmentSchema.parse({ ...base, trackingNumber: '1Z 999 AA1 01' }).trackingNumber).toBe('1Z999AA101');
    });

    it.each(['abc', 'has/slash', 'x'.repeat(41)])('rejects tracking number %p', (trackingNumber) => {
        expect(() => recordShipmentSchema.parse({ ...base, trackingNumber })).toThrow();
    });

    it.each(['http://carrier.example/t/1', 'javascript:alert(1)', 'not a url'])('rejects tracking link %p', (trackingUrl) => {
        expect(() => recordShipmentSchema.parse({ ...base, trackingUrl })).toThrow();
    });

    it('accepts an https tracking link and defaults allowDuplicate to false', () => {
        const dto = recordShipmentSchema.parse({ ...base, trackingUrl: 'https://carrier.example/track/1490000000123' });
        expect(dto).toMatchObject({ trackingUrl: 'https://carrier.example/track/1490000000123', allowDuplicate: false });
    });

    it('a correction needs a reason', () => {
        expect(() => replaceShipmentSchema.parse(base)).toThrow();
        expect(replaceShipmentSchema.parse({ ...base, reason: 'Typo in number' }).reason).toBe('Typo in number');
    });
});

function shipmentRow(over: Record<string, unknown> = {}) {
    return {
        id: 'shp-1', orderId: 'o1', carrierName: 'Delhivery', trackingNumber: '1490000000123', trackingUrl: null,
        note: null, status: 'ACTIVE', createdById: 'ops-1', createdAt: new Date('2026-10-20T10:00:00Z'),
        deliveredAt: null, deliveredVia: null, voidedAt: null, voidedById: null, voidReason: null,
        updatedAt: new Date('2026-10-20T10:00:00Z'), publicCode: null, ...over,
    };
}

function build(opts: { order?: unknown; duplicate?: string | null; buyerOrder?: unknown } = {}) {
    const shipments = {
        findOrder: jest.fn(async () => (opts.order === undefined ? { id: 'o1', status: 'PROCESSING', organizationId: 'org-1', buyerId: 'buyer-1', unitAssignedAt: new Date() } : opts.order)),
        findDuplicate: jest.fn(async () => opts.duplicate ?? null),
        record: jest.fn(async () => shipmentRow()),
        replace: jest.fn(async () => ({ previous: shipmentRow({ status: 'VOIDED' }), current: shipmentRow({ id: 'shp-2', trackingNumber: '1490000000999' }) })),
        findForBuyer: jest.fn(async () => opts.buyerOrder ?? null),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const eventBus = { publish: jest.fn(async () => undefined) };
    const service = new OrderShipmentService({ shipments: shipments as never, audit, eventBus: eventBus as never, logger: silentLogger });
    return { service, shipments, audit, eventBus };
}

const dto = recordShipmentSchema.parse({ carrierName: 'Delhivery', trackingNumber: '1490000000123' });

describe('OrderShipmentService.record', () => {
    it('ships the order, audits it and publishes SHIPPED + shipment-recorded', async () => {
        const { service, shipments, audit, eventBus } = build();
        const view = await service.record('o1', dto, ADMIN);

        expect(view).toMatchObject({ carrierName: 'Delhivery', trackingNumber: '1490000000123', status: 'ACTIVE' });
        expect(shipments.record).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', actorId: 'ops-1', trackingUrl: null }));
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'order.shipment.record',
            actor: { type: 'HITBOX_EMPLOYEE', id: 'ops-1' },
            afterState: expect.objectContaining({ status: 'SHIPPED', trackingNumber: '1490000000123' }),
        }));
        expect(eventBus.publish.mock.calls.map((c) => c[0])).toEqual(['orders.order.status-changed', 'orders.order.shipment-recorded']);
    });

    it('refuses a tracking number already on another order, unless allowDuplicate', async () => {
        const { service, shipments } = build({ duplicate: 'o-other' });
        await expect(service.record('o1', dto, ADMIN)).rejects.toMatchObject({ code: 'ORDERS_TRACKING_IN_USE', statusCode: 409 });
        expect(shipments.record).not.toHaveBeenCalled();

        await service.record('o1', { ...dto, allowDuplicate: true }, ADMIN);
        expect(shipments.record).toHaveBeenCalled();
    });

    it("another organization's order is a 404, not a 403", async () => {
        const { service } = build();
        await expect(service.record('o1', dto, { userId: 'x', organizationIds: ['org-2'] })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('a brand operator is audited as BRAND_EMPLOYEE', async () => {
        const { service, audit } = build();
        await service.record('o1', dto, { userId: 'brand-ops', organizationIds: ['org-1'] });
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: 'BRAND_EMPLOYEE', id: 'brand-ops' } }));
    });
});

describe('OrderShipmentService.replace', () => {
    it('audits old and new tracking with the reason, and does not publish a status change', async () => {
        const { service, audit, eventBus } = build({ order: { id: 'o1', status: 'SHIPPED', organizationId: 'org-1', buyerId: 'b', unitAssignedAt: new Date() } });
        await service.replace('o1', replaceShipmentSchema.parse({ carrierName: 'Delhivery', trackingNumber: '1490000000999', reason: 'Typo' }), ADMIN);
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
            beforeState: expect.objectContaining({ trackingNumber: '1490000000123' }),
            afterState: expect.objectContaining({ trackingNumber: '1490000000999', reason: 'Typo' }),
        }));
        expect(eventBus.publish.mock.calls.map((c) => c[0])).toEqual(['orders.order.shipment-recorded']);
    });
});

describe('OrderShipmentService.buyerTracking', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h));
    const order = {
        id: 'o1', buyerId: 'buyer-1', status: 'SHIPPED', placedAt: at(1), paidAt: at(2), shippedAt: at(5), deliveredAt: null,
        shipments: [shipmentRow({ trackingUrl: 'https://carrier.example/t/1', note: 'fragile — internal' })],
        statusHistory: [
            { toStatus: 'PENDING_PAYMENT', occurredAt: at(1) },
            { toStatus: 'PAID', occurredAt: at(2) },
            { toStatus: 'PAID', occurredAt: at(2) },
            { toStatus: 'PROCESSING', occurredAt: at(3) },
            { toStatus: 'SHIPPED', occurredAt: at(5) },
        ],
    };

    it('gives the buyer carrier, number and link, and a de-duplicated timeline', async () => {
        const { service } = build({ buyerOrder: order });
        const view = await service.buyerTracking('o1', 'buyer-1');
        expect(view.shipment).toEqual({
            carrierName: 'Delhivery', trackingNumber: '1490000000123', trackingUrl: 'https://carrier.example/t/1',
            shippedAt: '2026-10-20T10:00:00.000Z', deliveredAt: null, deliveredVia: null,
        });
        expect(view.timeline.map((t) => t.status)).toEqual(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED']);
        expect(JSON.stringify(view)).not.toContain('internal');
        expect(JSON.stringify(view)).not.toContain('ops-1');
    });

    it("someone else's order is a 404", async () => {
        const { service } = build({ buyerOrder: order });
        await expect(service.buyerTracking('o1', 'buyer-2')).rejects.toBeInstanceOf(AppError);
        await expect(service.buyerTracking('o1', 'buyer-2')).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('OrderService.changeStatus — SHIPPED', () => {
    it('is refused: an order ships by recording its shipment', async () => {
        const orders = {
            findById: jest.fn(async () => ({ id: 'o1', status: 'PROCESSING', organizationId: null, unitAssignedAt: new Date() })),
            changeStatus: jest.fn(),
        };
        const service = new OrderService({
            orders: orders as never, writes: {} as never, audit: { record: jest.fn() },
            eventBus: { publish: jest.fn() } as never, logger: silentLogger,
        });
        await expect(
            service.changeStatus({ id: 'o1', dto: { status: 'SHIPPED' }, view: { organizationIds: null, canSeeMoney: false, canSeeBuyer: false }, actorId: 'ops' }),
        ).rejects.toMatchObject({ code: 'ORDERS_SHIPMENT_REQUIRED', statusCode: 400 });
        expect(orders.changeStatus).not.toHaveBeenCalled();
    });
});
