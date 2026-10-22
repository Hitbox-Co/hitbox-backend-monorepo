import { Prisma } from '@hitbox/database';
import { listBuyerOrdersQuerySchema } from '../src/dto/buyer-order.dto';
import { BuyerOrderService } from '../src/service/buyer-order.service';

/**
 * "My orders" — docs/orders/buyer-orders-api.md. The repository is faked; the
 * queries run against a real database separately.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const dec = (v: string) => new Prisma.Decimal(v);
const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h));

const drop = {
    id: 'drop-1', name: 'Neon Nights Tour Tee', groupCode: 'KZ-NN',
    artist: { name: 'Kaze' },
    dropImages: [{ asset: { storageRef: 'drop-images/tee.png' } }],
};

function detailRow(over: Record<string, unknown> = {}) {
    return {
        id: 'o1', publicCode: 'odr0abc', buyerId: 'buyer-1', status: 'SHIPPED',
        placedAt: at(1), paidAt: at(2), shippedAt: at(6), deliveredAt: null, quantity: 1,
        amount: dec('2499.00'), unitPrice: dec('2499.00'), currency: 'INR',
        unitAssignedAt: at(4), claimId: null, claimedAt: null,
        drop,
        variant: { id: 'v1', label: 'M / Black', options: [
            { dimensionLabel: 'Size', valueLabel: 'M', hexCode: null },
            { dimensionLabel: 'Colour', valueLabel: 'Black', hexCode: '#000000' },
        ] },
        sku: { skuCode: 'KZ-NN-000014', serialNumber: 14, claimedStatus: 'UNCLAIMED', ownerId: null },
        orderAddresss: [{ usage: 'SHIPPING', recipientName: 'Asha', line1: '1 MG Road', line2: null, city: 'Bengaluru', state: 'KA', postalCode: '560001', countryCode: 'IN', phone: null }],
        inventoryReservations: [],
        paymentTransactions: [{ status: 'SUCCEEDED', amount: dec('2499.00'), failureReason: null }],
        refundRequests: [],
        shipments: [{ carrierName: 'Delhivery', trackingNumber: '1490000000123', trackingUrl: null, createdAt: at(6), deliveredAt: null, deliveredVia: null }],
        statusHistory: [
            { toStatus: 'PENDING_PAYMENT', occurredAt: at(1) }, { toStatus: 'PAID', occurredAt: at(2) },
            { toStatus: 'PROCESSING', occurredAt: at(4) }, { toStatus: 'SHIPPED', occurredAt: at(6) },
        ],
        invoice: { id: 'inv-1', invoiceNumber: 'HB/2026-27/0001', invoiceDate: at(2), totalAmount: dec('2499.00'), currency: 'INR' },
        ...over,
    };
}

function build(opts: { detail?: unknown; owner?: unknown; cancelled?: boolean } = {}) {
    const orders = {
        list: jest.fn(async () => ({ total: 1, items: [{ ...detailRow(), refundRequests: [{ id: 'r1' }] }] })),
        countByStatus: jest.fn(async () => ({ PENDING_PAYMENT: 1, SHIPPED: 2, DELIVERED: 4, CANCELLED: 1, REFUNDED: 1 })),
        findDetail: jest.fn(async () => (opts.detail === undefined ? detailRow() : opts.detail)),
        findOwner: jest.fn(async () => opts.owner ?? { buyerId: 'buyer-1', status: 'PENDING_PAYMENT', archivedAt: null }),
    };
    const writes = { cancelUnpaid: jest.fn(async () => opts.cancelled ?? true) };
    const eventBus = { publish: jest.fn(async () => undefined) };
    const service = new BuyerOrderService({
        orders: orders as never, writes: writes as never,
        mediaUrls: { publicUrl: (ref: string) => `https://cdn.example/${ref}` },
        eventBus: eventBus as never, logger: silentLogger,
    });
    return { service, orders, writes, eventBus };
}

describe('GET /orders — list', () => {
    it('filters by tab, and always returns every tab count', async () => {
        const { service, orders } = build();
        const list = await service.list('buyer-1', listBuyerOrdersQuerySchema.parse({ tab: 'active' }));

        expect(orders.list).toHaveBeenCalledWith(expect.objectContaining({
            buyerId: 'buyer-1', statuses: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'], skip: 0, take: 10,
        }));
        expect(list.counts).toEqual({ all: 9, active: 3, completed: 4, cancelled: 2 });
        expect(list.items[0]).toMatchObject({
            reference: 'odr0abc', statusLabel: 'Shipped', variantLabel: 'M / Black', amount: '2499.00',
            product: { name: 'Neon Nights Tour Tee', imageUrl: 'https://cdn.example/drop-images/tee.png', artistName: 'Kaze' },
            tracking: { carrierName: 'Delhivery', trackingNumber: '1490000000123' },
            refundInProgress: true,
        });
    });

    it('tab "all" applies no status filter', async () => {
        const { service, orders } = build();
        await service.list('buyer-1', listBuyerOrdersQuerySchema.parse({}));
        expect(orders.list).toHaveBeenCalledWith(expect.objectContaining({ statuses: null }));
    });
});

describe('GET /orders/:orderId — detail', () => {
    it('a shipped order: unit, variant options, tracking, invoice and the right actions', async () => {
        const { service } = build();
        const d = await service.get('buyer-1', 'o1');

        expect(d.unit).toEqual({ skuCode: 'KZ-NN-000014', serialNumber: 14, claimed: false, claimedAt: null });
        expect(d.variant?.options[1]).toEqual({ dimension: 'Colour', value: 'Black', hexCode: '#000000' });
        expect(d.payment).toMatchObject({ status: 'PAID', payBy: null });
        expect(d.tracking).toMatchObject({ carrierName: 'Delhivery' });
        expect(d.invoice).toMatchObject({ number: 'HB/2026-27/0001', totalAmount: '2499.00' });
        expect(d.actions).toEqual({
            canCancel: false, canResumePayment: false, canRequestRefund: true, refundBlockedReason: null,
            canTrack: true, canDownloadInvoice: true,
        });
        expect(d.timeline.map((t) => t.status)).toEqual(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED']);
    });

    it('an unpaid order with a live hold can be paid or cancelled, and shows a pay-by time', async () => {
        const payBy = new Date(Date.now() + 10 * 60_000);
        const { service } = build({ detail: detailRow({
            status: 'PENDING_PAYMENT', paidAt: null, shippedAt: null, unitAssignedAt: null, shipments: [], invoice: null,
            inventoryReservations: [{ expiresAt: payBy }], paymentTransactions: [{ status: 'PENDING', amount: dec('2499.00'), failureReason: null }],
        }) });
        const d = await service.get('buyer-1', 'o1');
        expect(d.payment).toMatchObject({ status: 'AWAITING_PAYMENT', payBy: payBy.toISOString() });
        expect(d.unit).toBeNull(); // no number promised before packing
        expect(d.actions).toMatchObject({ canCancel: true, canResumePayment: true, canRequestRefund: false, refundBlockedReason: 'ORDER_NOT_REFUNDABLE' });
    });

    it('an open refund blocks another and is shown with a buyer label', async () => {
        const { service } = build({ detail: detailRow({ refundRequests: [{
            id: 'r1', status: 'AWAITING_RETURN', reasonCode: 'DEFECTIVE_ITEM', reason: 'Torn seam', amount: dec('2499.00'), currency: 'INR',
            physicalReturnRequired: true, physicalReturnConfirmedAt: null, rejectionReason: null, processedAt: null, gatewayStatus: null, createdAt: at(8),
        }] }) });
        const d = await service.get('buyer-1', 'o1');
        expect(d.refunds[0]).toMatchObject({ statusLabel: 'Waiting for your return', returnRequired: true, failed: false });
        expect(d.actions).toMatchObject({ canRequestRefund: false, refundBlockedReason: 'REFUND_IN_PROGRESS' });
    });

    it('claimed only when this buyer owns the unit', async () => {
        const { service } = build({ detail: detailRow({ status: 'DELIVERED', claimId: 'c1', claimedAt: at(30), sku: { skuCode: 'X', serialNumber: 1, claimedStatus: 'CLAIMED', ownerId: 'buyer-1' } }) });
        expect((await service.get('buyer-1', 'o1')).unit).toMatchObject({ claimed: true, claimedAt: at(30).toISOString() });
    });

    it("someone else's order is a 404", async () => {
        const { service } = build();
        await expect(service.get('buyer-2', 'o1')).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('POST /orders/:orderId/cancel', () => {
    it('cancels an unpaid order as the buyer and frees the hold', async () => {
        const { service, writes, eventBus } = build();
        await service.cancel('buyer-1', 'o1', { reason: 'Changed my mind' });
        expect(writes.cancelUnpaid).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', source: 'BUYER', actorId: 'buyer-1', reason: 'Changed my mind' }));
        expect(eventBus.publish).toHaveBeenCalledWith('orders.order.status-changed', expect.objectContaining({ to: 'CANCELLED', actorId: 'buyer-1' }));
    });

    it('a paid order points the buyer to a refund', async () => {
        const { service, writes } = build({ owner: { buyerId: 'buyer-1', status: 'PAID', archivedAt: null } });
        await expect(service.cancel('buyer-1', 'o1', {})).rejects.toMatchObject({ code: 'ORDERS_CANCEL_REQUIRES_REFUND' });
        expect(writes.cancelUnpaid).not.toHaveBeenCalled();
    });

    it('cancelling twice is not an error', async () => {
        const { service, writes } = build({ owner: { buyerId: 'buyer-1', status: 'CANCELLED', archivedAt: null } });
        await expect(service.cancel('buyer-1', 'o1', {})).resolves.toBeDefined();
        expect(writes.cancelUnpaid).not.toHaveBeenCalled();
    });

    it('payment landing at the same moment wins (409)', async () => {
        const { service } = build({ cancelled: false });
        await expect(service.cancel('buyer-1', 'o1', {})).rejects.toMatchObject({ statusCode: 409 });
    });

    it("someone else's order is a 404", async () => {
        const { service } = build();
        await expect(service.cancel('buyer-2', 'o1', {})).rejects.toMatchObject({ statusCode: 404 });
    });
});
