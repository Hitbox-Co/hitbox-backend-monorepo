import { randomUUID } from 'node:crypto';
import type { OrderShipment, Prisma, PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { ORDERS_ERROR_CODES } from '../constants/orders.constant';
import { recordStatusChange } from './order-history';

interface ShipmentInput {
    orderId: string;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string | null;
    note: string | null;
    actorId: string;
    now: Date;
}

/**
 * Shipments: recording the parcel that ships an order, and correcting it.
 *
 * Both writes lock the order row first, so two operators pressing "Ship" at
 * once produce one shipment and one clean conflict — the "one ACTIVE
 * shipment per order" rule is enforced here, under that lock, rather than by
 * a partial index Prisma cannot express.
 */
export class OrderShipmentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** What the service needs to scope-check and validate before writing. */
    findOrder(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: { id: true, status: true, organizationId: true, buyerId: true, unitAssignedAt: true },
        });
    }

    /** Another order already carrying this carrier + number on a live shipment. */
    async findDuplicate(input: { carrierName: string; trackingNumber: string; excludeOrderId: string }): Promise<string | null> {
        const row = await this.prisma.orderShipment.findFirst({
            where: {
                status: 'ACTIVE',
                orderId: { not: input.excludeOrderId },
                trackingNumber: { equals: input.trackingNumber, mode: 'insensitive' },
                carrierName: { equals: input.carrierName, mode: 'insensitive' },
            },
            select: { orderId: true },
        });
        return row?.orderId ?? null;
    }

    /**
     * PROCESSING → SHIPPED, with the parcel that justifies it, in one
     * transaction: the shipment, the status, `shippedAt`, the legacy
     * `trackingNote` (kept in step for older screens) and the history row.
     */
    async record(input: ShipmentInput): Promise<OrderShipment> {
        return this.prisma.$transaction(async (tx) => {
            const order = await this.lockOrder(tx, input.orderId);
            if (order.status !== 'PROCESSING') {
                throw AppError.badRequest(
                    `An order that is ${order.status} cannot be shipped — it must be PROCESSING (unit scanned at packing).`,
                    ORDERS_ERROR_CODES.NOT_SHIPPABLE,
                    { status: order.status },
                );
            }
            if (order.unitAssignedAt === null) {
                throw AppError.badRequest(
                    'Scan the item going into this parcel before shipping it (POST /admin/orders/:orderId/unit).',
                    ORDERS_ERROR_CODES.UNIT_NOT_ASSIGNED,
                );
            }
            if (await tx.orderShipment.count({ where: { orderId: input.orderId, status: 'ACTIVE' } })) {
                throw AppError.conflict(
                    'This order already has a shipment. Correct it with PUT /admin/orders/:orderId/shipment.',
                    ORDERS_ERROR_CODES.SHIPMENT_EXISTS,
                );
            }

            const shipment = await this.createShipment(tx, input);
            await tx.order.update({
                where: { id: input.orderId },
                data: {
                    status: 'SHIPPED',
                    shippedAt: input.now,
                    trackingNote: `${input.carrierName} ${input.trackingNumber}`,
                    updatedAt: input.now,
                },
            });
            await recordStatusChange(tx, {
                orderId: input.orderId, from: 'PROCESSING', to: 'SHIPPED', source: 'SHIPMENT',
                actorId: input.actorId,
                metadata: { shipmentId: shipment.id, carrierName: input.carrierName, trackingNumber: input.trackingNumber },
                at: input.now,
            });
            return shipment;
        });
    }

    /**
     * Corrects the tracking on a SHIPPED order: the current shipment is
     * voided (with who and why) and a new one takes its place. Not a status
     * change, so no history row — the audit log and the voided row record it.
     */
    async replace(input: ShipmentInput & { reason: string }): Promise<{ previous: OrderShipment; current: OrderShipment }> {
        return this.prisma.$transaction(async (tx) => {
            const order = await this.lockOrder(tx, input.orderId);
            if (order.status !== 'SHIPPED') {
                throw AppError.badRequest(
                    `Tracking can be corrected while the order is SHIPPED; this one is ${order.status}.`,
                    ORDERS_ERROR_CODES.NOT_SHIPPABLE,
                    { status: order.status },
                );
            }
            const previous = await tx.orderShipment.findFirst({ where: { orderId: input.orderId, status: 'ACTIVE' } });
            if (!previous) {
                throw AppError.badRequest(
                    'This order has no recorded shipment to correct.',
                    ORDERS_ERROR_CODES.NOT_SHIPPABLE,
                );
            }

            const voided = await tx.orderShipment.update({
                where: { id: previous.id },
                data: {
                    status: 'VOIDED', voidedAt: input.now, voidedById: input.actorId,
                    voidReason: input.reason, updatedAt: input.now,
                },
            });
            const current = await this.createShipment(tx, input);
            await tx.order.update({
                where: { id: input.orderId },
                data: { trackingNote: `${input.carrierName} ${input.trackingNumber}`, updatedAt: input.now },
            });
            return { previous: voided, current };
        });
    }

    /** The buyer's view: the order, its live shipment and its timeline. */
    findForBuyer(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true, buyerId: true, status: true, placedAt: true, paidAt: true,
                shippedAt: true, deliveredAt: true,
                shipments: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 1 },
                statusHistory: { orderBy: { occurredAt: 'asc' }, select: { toStatus: true, occurredAt: true } },
            },
        });
    }

    private async lockOrder(tx: Prisma.TransactionClient, orderId: string) {
        await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { status: true, unitAssignedAt: true },
        });
        if (!order) throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        return order;
    }

    private createShipment(tx: Prisma.TransactionClient, input: ShipmentInput): Promise<OrderShipment> {
        return tx.orderShipment.create({
            data: {
                id: randomUUID(),
                orderId: input.orderId,
                carrierName: input.carrierName,
                trackingNumber: input.trackingNumber,
                trackingUrl: input.trackingUrl,
                note: input.note,
                status: 'ACTIVE',
                createdById: input.actorId,
                createdAt: input.now,
                updatedAt: input.now,
            },
        });
    }
}
