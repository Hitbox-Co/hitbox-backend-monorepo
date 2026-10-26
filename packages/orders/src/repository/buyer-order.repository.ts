import type { OrderStatus, Prisma, PrismaClient } from '@hitbox/database';

/** The primary product image, as a storage key the media resolver turns into a URL. */
const productSelect = {
    id: true,
    name: true,
    groupCode: true,
    artist: { select: { name: true } },
    dropImages: {
        where: { archivedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
        take: 1,
        select: { asset: { select: { storageRef: true } } },
    },
} satisfies Prisma.DropSelect;

const openRefund = { status: { in: ['REQUESTED', 'AWAITING_RETURN', 'APPROVED'] } } satisfies Prisma.RefundRequestWhereInput;

const listSelect = {
    id: true,
    publicCode: true,
    status: true,
    placedAt: true,
    deliveredAt: true,
    quantity: true,
    amount: true,
    currency: true,
    drop: { select: productSelect },
    variant: { select: { label: true } },
    shipments: {
        where: { status: 'ACTIVE' },
        take: 1,
        select: { carrierName: true, trackingNumber: true, trackingUrl: true },
    },
    refundRequests: { where: openRefund, take: 1, select: { id: true } },
} satisfies Prisma.OrderSelect;

export type BuyerOrderListRow = Prisma.OrderGetPayload<{ select: typeof listSelect }>;

const detailSelect = {
    ...listSelect,
    buyerId: true,
    unitPrice: true,
    paidAt: true,
    shippedAt: true,
    unitAssignedAt: true,
    claimId: true,
    claimedAt: true,
    variant: {
        select: {
            id: true,
            label: true,
            options: {
                orderBy: { position: 'asc' },
                select: { dimensionLabel: true, valueLabel: true, hexCode: true },
            },
        },
    },
    sku: { select: { skuCode: true, serialNumber: true, claimedStatus: true, ownerId: true } },
    orderAddresss: {
        select: {
            usage: true, recipientName: true, line1: true, line2: true, city: true, state: true,
            postalCode: true, countryCode: true, phone: true,
        },
    },
    // The live hold, for "pay by" while unpaid.
    inventoryReservations: {
        where: { status: 'HELD' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { expiresAt: true },
    },
    paymentTransactions: {
        orderBy: { createdAt: 'desc' },
        select: { status: true, amount: true, failureReason: true },
    },
    refundRequests: {
        orderBy: { createdAt: 'desc' },
        select: {
            id: true, status: true, reasonCode: true, reason: true, amount: true, currency: true,
            physicalReturnRequired: true, physicalReturnConfirmedAt: true, rejectionReason: true,
            processedAt: true, gatewayStatus: true, createdAt: true,
            // How many photos the buyer attached. The photos themselves (with
            // signed URLs) come from GET /refunds/:refundId — orders has no
            // business minting URLs into the media bucket.
            _count: { select: { evidence: true } },
        },
    },
    shipments: {
        where: { status: 'ACTIVE' },
        take: 1,
        select: {
            carrierName: true, trackingNumber: true, trackingUrl: true,
            createdAt: true, deliveredAt: true, deliveredVia: true,
        },
    },
    statusHistory: { orderBy: { occurredAt: 'asc' }, select: { toStatus: true, occurredAt: true } },
    invoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, currency: true } },
} satisfies Prisma.OrderSelect;

export type BuyerOrderDetailRow = Prisma.OrderGetPayload<{ select: typeof detailSelect }>;

/**
 * Reads for the buyer's own orders. Every query is keyed on `buyerId` — the
 * only filter that matters here, and the one that makes "someone else's
 * order" indistinguishable from "no such order".
 */
export class BuyerOrderRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(input: {
        buyerId: string;
        statuses: readonly OrderStatus[] | null;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: BuyerOrderListRow[] }> {
        const where: Prisma.OrderWhereInput = {
            buyerId: input.buyerId,
            archivedAt: null,
            ...(input.statuses ? { status: { in: [...input.statuses] } } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                select: listSelect,
                orderBy: { placedAt: 'desc' },
                skip: input.skip,
                take: input.take,
            }),
        ]);
        return { total, items };
    }

    /** Orders per status, for the tab badges. One grouped query. */
    async countByStatus(buyerId: string): Promise<Record<string, number>> {
        const rows = await this.prisma.order.groupBy({
            by: ['status'],
            where: { buyerId, archivedAt: null },
            _count: { _all: true },
        });
        return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
    }

    findDetail(orderId: string): Promise<BuyerOrderDetailRow | null> {
        return this.prisma.order.findFirst({
            where: { id: orderId, archivedAt: null },
            select: detailSelect,
        });
    }

    findOwner(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: { buyerId: true, status: true, archivedAt: true },
        });
    }
}
