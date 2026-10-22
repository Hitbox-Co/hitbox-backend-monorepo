import { randomUUID } from 'node:crypto';
import type { OrderShipment } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { ORDER_EVENTS, ORDERS_ERROR_CODES } from '../constants/orders.constant';
import type { IOrdersAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type {
    BuyerTrackingView,
    RecordShipmentDto,
    ReplaceShipmentDto,
    ShipmentView,
} from '../dto/order-shipment.dto';
import type { OrderShipmentRepository } from '../repository/order-shipment.repository';

export interface ShipmentCaller {
    userId: string;
    /** Organizations the caller may act in, or null for platform-wide. */
    organizationIds: string[] | null;
}

export interface OrderShipmentServiceDeps {
    shipments: OrderShipmentRepository;
    audit: IOrdersAuditRecorder;
    eventBus: IEventBus;
    logger: Logger;
}

export const ORDERS_AUDIT_EVENTS = {
    STATUS_CHANGE: 'order.status.change',
    SHIPMENT_RECORD: 'order.shipment.record',
} as const;

/** HitBox staff act platform-wide; a brand's staff are scoped to their organizations. */
export function auditActorType(caller: { organizationIds: string[] | null }) {
    return caller.organizationIds === null ? ('HITBOX_EMPLOYEE' as const) : ('BRAND_EMPLOYEE' as const);
}

/**
 * Shipping an order with a tracking number, correcting it, and showing it to
 * the buyer — docs/orders/order-history-and-shipments.md.
 *
 * There is no carrier integration: HitBox ships with whichever carrier suits
 * the parcel and records what the carrier gave it. Delivery is then confirmed
 * by an operator (from the carrier's own tracking page) or, automatically, by
 * the buyer tapping the item's NFC tag.
 */
export class OrderShipmentService {
    constructor(private readonly deps: OrderShipmentServiceDeps) { }

    async record(orderId: string, dto: RecordShipmentDto, caller: ShipmentCaller): Promise<ShipmentView> {
        const order = await this.requireInScope(orderId, caller);
        await this.refuseDuplicate(orderId, dto);

        const now = new Date();
        const shipment = await this.deps.shipments.record({
            orderId,
            carrierName: dto.carrierName,
            trackingNumber: dto.trackingNumber,
            trackingUrl: dto.trackingUrl ?? null,
            note: dto.note ?? null,
            actorId: caller.userId,
            now,
        });

        await this.deps.audit.record({
            eventType: ORDERS_AUDIT_EVENTS.SHIPMENT_RECORD,
            actor: { type: auditActorType(caller), id: caller.userId },
            result: 'SUCCESS',
            organizationId: order.organizationId,
            resource: { type: 'Order', id: orderId },
            beforeState: { status: 'PROCESSING' },
            afterState: { status: 'SHIPPED', ...this.auditShipment(shipment) },
            correlationId: randomUUID(),
        });
        await this.deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
            orderId, from: 'PROCESSING', to: 'SHIPPED', actorId: caller.userId, reason: null,
        });
        await this.deps.eventBus.publish(ORDER_EVENTS.SHIPMENT_RECORDED, {
            orderId, buyerId: order.buyerId, shipmentId: shipment.id,
            carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl, corrected: false,
        });
        this.deps.logger.info({ orderId, shipmentId: shipment.id, actorId: caller.userId }, 'order shipped');
        return toShipmentView(shipment);
    }

    async replace(orderId: string, dto: ReplaceShipmentDto, caller: ShipmentCaller): Promise<ShipmentView> {
        const order = await this.requireInScope(orderId, caller);
        await this.refuseDuplicate(orderId, dto);

        const { previous, current } = await this.deps.shipments.replace({
            orderId,
            carrierName: dto.carrierName,
            trackingNumber: dto.trackingNumber,
            trackingUrl: dto.trackingUrl ?? null,
            note: dto.note ?? null,
            reason: dto.reason,
            actorId: caller.userId,
            now: new Date(),
        });

        await this.deps.audit.record({
            eventType: ORDERS_AUDIT_EVENTS.SHIPMENT_RECORD,
            actor: { type: auditActorType(caller), id: caller.userId },
            result: 'SUCCESS',
            organizationId: order.organizationId,
            resource: { type: 'Order', id: orderId },
            beforeState: this.auditShipment(previous),
            afterState: { ...this.auditShipment(current), reason: dto.reason },
            correlationId: randomUUID(),
        });
        await this.deps.eventBus.publish(ORDER_EVENTS.SHIPMENT_RECORDED, {
            orderId, buyerId: order.buyerId, shipmentId: current.id,
            carrierName: current.carrierName, trackingNumber: current.trackingNumber,
            trackingUrl: current.trackingUrl, corrected: true,
        });
        return toShipmentView(current);
    }

    /** `GET /orders/:orderId/tracking` — the buyer's own order only; anything else is a 404. */
    async buyerTracking(orderId: string, buyerId: string): Promise<BuyerTrackingView> {
        const order = await this.deps.shipments.findForBuyer(orderId);
        if (!order || order.buyerId !== buyerId) {
            throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        const shipment = order.shipments[0] ?? null;

        // One entry per status reached, oldest first. Repeats (a BACKFILL row
        // plus a later identical status) collapse to the first.
        const timeline: { status: string; at: string }[] = [];
        for (const row of order.statusHistory) {
            if (timeline.at(-1)?.status === row.toStatus) continue;
            timeline.push({ status: row.toStatus, at: row.occurredAt.toISOString() });
        }

        return {
            orderId: order.id,
            status: order.status,
            placedAt: order.placedAt.toISOString(),
            paidAt: order.paidAt?.toISOString() ?? null,
            shippedAt: order.shippedAt?.toISOString() ?? null,
            deliveredAt: order.deliveredAt?.toISOString() ?? null,
            shipment: shipment
                ? {
                    carrierName: shipment.carrierName,
                    trackingNumber: shipment.trackingNumber,
                    trackingUrl: shipment.trackingUrl,
                    shippedAt: shipment.createdAt.toISOString(),
                    deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
                    deliveredVia: shipment.deliveredVia,
                }
                : null,
            timeline,
        };
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Out of scope and missing are the same 404 — see OrderService.requireInScope. */
    private async requireInScope(orderId: string, caller: ShipmentCaller) {
        const order = await this.deps.shipments.findOrder(orderId);
        const visible =
            order !== null &&
            (caller.organizationIds === null ||
                (order.organizationId !== null && caller.organizationIds.includes(order.organizationId)));
        if (!visible) throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        return order;
    }

    private async refuseDuplicate(orderId: string, dto: RecordShipmentDto): Promise<void> {
        if (dto.allowDuplicate) return;
        const other = await this.deps.shipments.findDuplicate({
            carrierName: dto.carrierName,
            trackingNumber: dto.trackingNumber,
            excludeOrderId: orderId,
        });
        if (other) {
            throw AppError.conflict(
                'This carrier and tracking number are already on another order. Check you copied the right one, or send allowDuplicate: true if it really is one parcel.',
                ORDERS_ERROR_CODES.TRACKING_IN_USE,
                { orderId: other },
            );
        }
    }

    private auditShipment(shipment: OrderShipment) {
        return {
            shipmentId: shipment.id,
            carrierName: shipment.carrierName,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
        };
    }
}

export function toShipmentView(row: OrderShipment): ShipmentView {
    return {
        id: row.id,
        carrierName: row.carrierName,
        trackingNumber: row.trackingNumber,
        trackingUrl: row.trackingUrl,
        note: row.note,
        status: row.status,
        createdById: row.createdById,
        createdAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        deliveredVia: row.deliveredVia,
        voidedAt: row.voidedAt?.toISOString() ?? null,
        voidedById: row.voidedById,
        voidReason: row.voidReason,
    };
}
