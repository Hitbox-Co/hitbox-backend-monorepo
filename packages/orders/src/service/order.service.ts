import { OrderStatus } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { ORDER_EVENTS, ORDERS_ERROR_CODES } from '../constants/orders.constant';
import {
    ADMIN_SETTABLE_STATUSES,
    ORDER_STATUS_TRANSITIONS,
    canTransition,
    timestampsFor,
} from '../domain/order-status';
import { buildMoneySummary } from '../domain/order-money';
import type {
    ChangeOrderStatusDto,
    ListOrdersQuery,
    OrderDetail,
    OrderListItem,
    OrderSkuUnit,
} from '../dto/order.dto';
import type {
    OrderDetailRow,
    OrderListRow,
    OrderRepository,
} from '../repository/order.repository';
import type { OrderWriteRepository } from '../repository/order-write.repository';
import type { IOrdersAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { ORDERS_AUDIT_EVENTS, auditActorType, toShipmentView } from './order-shipment.service';
import { randomUUID } from 'node:crypto';

/**
 * What the caller is allowed to see. Resolved from their grants by the
 * controller — never from the request.
 */
export interface OrderView {
    /** Organizations the caller may read, or null for unrestricted. */
    organizationIds: string[] | null;
    /** `payment-royalty:read` — amounts, payments, refunds. */
    canSeeMoney: boolean;
    /** `buyer-profile:read` — the buyer's email and name. */
    canSeeBuyer: boolean;
    /**
     * `order:refund:global` — may start and drive refunds. Optional so older
     * callers stay valid; absent means "no".
     */
    canRefund?: boolean;
}

export interface OrderServiceDeps {
    orders: OrderRepository;
    writes: OrderWriteRepository;
    audit: IOrdersAuditRecorder;
    eventBus: IEventBus;
    logger: Logger;
}

export class OrderService {
    constructor(private readonly deps: OrderServiceDeps) { }

    async list(
        query: ListOrdersQuery,
        view: OrderView,
    ): Promise<{ page: number; limit: number; total: number; items: OrderListItem[] }> {
        // A buyer-email filter from a caller who may not see buyers would let
        // them confirm an address exists by watching the result count. Refuse
        // it rather than silently ignoring the filter.
        if (query.buyerEmail && !view.canSeeBuyer) {
            throw AppError.forbidden(
                'Filtering by buyer email requires buyer profile access.',
                ORDERS_ERROR_CODES.NOT_FOUND,
            );
        }

        const { total, items } = await this.deps.orders.list({
            ...query,
            organizationIds: view.organizationIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => this.toListItem(row, view)),
        };
    }

    async getById(id: string, view: OrderView): Promise<OrderDetail> {
        const order = await this.requireInScope(id, view);

        const base = this.toListItem(order, view);
        const detail: OrderDetail = {
            ...base,
            gateway: order.gateway,
            trackingNote: order.trackingNote,
            termsAcceptedAt: order.termsAcceptedAt?.toISOString() ?? null,
            updatedAt: order.updatedAt.toISOString(),
            paidAt: order.paidAt?.toISOString() ?? null,
            unitAssignedById: order.unitAssignedById,
            archivedAt: order.archivedAt?.toISOString() ?? null,
            market: order.market
                ? {
                    id: order.market.id,
                    code: order.market.code,
                    name: order.market.name,
                    currency: order.market.currency,
                }
                : null,
            skuUnits: this.toSkuUnits(order),
            addresses: order.orderAddresss.map((address) => ({
                usage: address.usage,
                label: address.label,
                labelCustom: address.labelCustom,
                recipientName: address.recipientName,
                line1: address.line1,
                line2: address.line2,
                city: address.city,
                state: address.state,
                postalCode: address.postalCode,
                countryCode: address.countryCode,
                phone: address.phone,
            })),
            // Precomputed so the UI enables exactly the buttons that will work,
            // instead of discovering the rule by getting a 409.
            // SHIPPED is withheld until a packer has scanned the unit.
            allowedTransitions: ORDER_STATUS_TRANSITIONS[order.status].filter(
                (status) => ADMIN_SETTABLE_STATUSES.includes(status) && status !== OrderStatus.SHIPPED,
            ),
            canRecordShipment:
                order.status === OrderStatus.PROCESSING &&
                order.unitAssignedAt !== null &&
                !order.shipments.some((s) => s.status === 'ACTIVE'),
            canCorrectShipment:
                order.status === OrderStatus.SHIPPED && order.shipments.some((s) => s.status === 'ACTIVE'),
            shipment: (() => {
                const active = order.shipments.find((s) => s.status === 'ACTIVE');
                return active ? toShipmentView(active) : null;
            })(),
            shipments: order.shipments.map(toShipmentView),
            history: order.statusHistory.map((row) => ({
                id: row.id,
                fromStatus: row.fromStatus,
                toStatus: row.toStatus,
                source: row.source,
                actorId: row.actorId,
                reason: row.reason,
                metadata: row.metadata,
                occurredAt: row.occurredAt.toISOString(),
            })),
        };

        if (view.canSeeMoney) {
            detail.money = buildMoneySummary({
                orderStatus: order.status,
                orderAmount: order.amount,
                currency: order.currency,
                payments: order.paymentTransactions,
                refunds: order.refundRequests,
                callerCanRefund: view.canRefund === true,
            });
            detail.payments = order.paymentTransactions.map((payment) => ({
                id: payment.id,
                status: payment.status,
                gateway: payment.gateway,
                gatewayRef: payment.gatewayRef,
                amount: payment.amount.toFixed(2),
                currency: payment.currency,
                needsReview: payment.needsReview,
                reviewedAt: payment.reviewedAt?.toISOString() ?? null,
                reviewNote: payment.reviewNote,
                failureReason: payment.failureReason,
                createdAt: payment.createdAt.toISOString(),
                updatedAt: payment.updatedAt.toISOString(),
            }));
            detail.refunds = order.refundRequests.map((refund) => ({
                id: refund.id,
                status: refund.status,
                reasonCode: refund.reasonCode,
                reason: refund.reason,
                amount: refund.amount?.toFixed(2) ?? null,
                currency: refund.currency ?? order.currency,
                physicalReturnRequired: refund.physicalReturnRequired,
                physicalReturnConfirmedAt: refund.physicalReturnConfirmedAt?.toISOString() ?? null,
                nfcTagCondition: refund.nfcTagCondition,
                approvedAt: refund.approvedAt?.toISOString() ?? null,
                rejectionReason: refund.rejectionReason,
                gatewayRefundId: refund.gatewayRefundId,
                gatewayStatus: refund.gatewayStatus,
                gatewayFailureReason: refund.gatewayFailureReason,
                gatewayStatusAt: refund.gatewayStatusAt?.toISOString() ?? null,
                processedAt: refund.processedAt?.toISOString() ?? null,
                claimRevokedAt: refund.claimRevokedAt?.toISOString() ?? null,
                createdAt: refund.createdAt.toISOString(),
                updatedAt: refund.updatedAt.toISOString(),
            }));
        }

        return detail;
    }

    /**
     * Move an order to a new status.
     *
     * Three refusals, in order: a status an operator may never set by hand, a
     * transition the lifecycle does not allow, and a concurrent change by
     * another operator.
     */
    async changeStatus(input: {
        id: string;
        dto: ChangeOrderStatusDto;
        view: OrderView;
        actorId: string;
    }): Promise<OrderDetail> {
        const order = await this.requireInScope(input.id, input.view);
        const { status: to } = input.dto;

        if (!ADMIN_SETTABLE_STATUSES.includes(to)) {
            throw AppError.badRequest(
                `${to} is written by the payments pipeline and cannot be set by hand.`,
                ORDERS_ERROR_CODES.STATUS_NOT_SETTABLE,
            );
        }
        if (to === OrderStatus.CANCELLED && (order.status === OrderStatus.PAID || order.status === OrderStatus.PROCESSING)) {
            throw AppError.badRequest(
                'This order has been paid. Cancel it by refunding it (POST /refunds with ' +
                'physicalReturnRequired: false) — that returns the money and puts the unit back on sale.',
                ORDERS_ERROR_CODES.CANCEL_REQUIRES_REFUND,
                { status: order.status },
            );
        }
        if (to === OrderStatus.SHIPPED) {
            throw AppError.badRequest(
                'An order ships by recording its carrier and tracking number: ' +
                'POST /admin/orders/:orderId/shipment.',
                ORDERS_ERROR_CODES.SHIPMENT_REQUIRED,
            );
        }
        if (order.status === to) {
            // Idempotent rather than an error — a double-clicked button should
            // not read as a failure.
            return this.getById(input.id, input.view);
        }
        if (!canTransition(order.status, to)) {
            throw AppError.badRequest(
                `An order that is ${order.status} cannot become ${to}.`,
                ORDERS_ERROR_CODES.INVALID_TRANSITION,
                { from: order.status, to, allowed: ORDER_STATUS_TRANSITIONS[order.status] },
            );
        }

        const now = new Date();
        // Cancelling an unpaid order also releases its stock hold; every other
        // transition is a plain guarded status write.
        const changed =
            to === OrderStatus.CANCELLED
                ? Number(
                    await this.deps.writes.cancelUnpaid({
                        orderId: input.id,
                        now,
                        source: 'ADMIN',
                        actorId: input.actorId,
                        reason: input.dto.reason ?? null,
                    }),
                )
                : await this.deps.orders.changeStatus({
                    id: input.id,
                    from: order.status,
                    to,
                    trackingNote: input.dto.trackingNote,
                    timestamps: timestampsFor(to, now),
                    now,
                    actorId: input.actorId,
                    reason: input.dto.reason ?? null,
                });

        if (changed === 0) {
            throw AppError.conflict(
                'This order changed while you were editing it. Reload and try again.',
                ORDERS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        await this.deps.audit.record({
            eventType: ORDERS_AUDIT_EVENTS.STATUS_CHANGE,
            actor: { type: auditActorType(input.view), id: input.actorId },
            result: 'SUCCESS',
            organizationId: order.organizationId,
            resource: { type: 'Order', id: input.id },
            beforeState: { status: order.status },
            afterState: { status: to, reason: input.dto.reason ?? null },
            correlationId: randomUUID(),
        });
        await this.deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
            orderId: input.id,
            from: order.status,
            to,
            actorId: input.actorId,
            reason: input.dto.reason ?? null,
        });
        this.deps.logger.info(
            { orderId: input.id, from: order.status, to, actorId: input.actorId },
            'order status changed',
        );

        return this.getById(input.id, input.view);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Out-of-scope and missing both return the **same** 404 — a distinct 403
     * would confirm the order exists, which is enough to enumerate another
     * organization's orders by id.
     */
    private async requireInScope(id: string, view: OrderView): Promise<OrderDetailRow> {
        const order = await this.deps.orders.findById(id);
        const visible =
            order !== null &&
            (view.organizationIds === null ||
                (order.organizationId !== null &&
                    view.organizationIds.includes(order.organizationId)));

        if (!visible) {
            throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        return order;
    }

    private toListItem(row: OrderListRow, view: OrderView): OrderListItem {
        const item: OrderListItem = {
            id: row.id,
            status: row.status,
            quantity: row.quantity,
            productId: row.productId,
            productCode: row.drop.groupCode,
            productName: row.drop.name,
            variantId: row.variantId,
            skuId: row.skuId,
            marketId: row.marketId,
            organizationId: row.organizationId,
            placedAt: row.placedAt.toISOString(),
            shippedAt: row.shippedAt?.toISOString() ?? null,
            deliveredAt: row.deliveredAt?.toISOString() ?? null,
            unitAssignedAt: row.unitAssignedAt?.toISOString() ?? null,
        };

        if (view.canSeeBuyer) {
            item.buyerId = row.buyerId;
            item.buyerEmail = row.buyer.email;
            item.buyerName = row.buyer.fullName;
        }
        if (view.canSeeMoney) {
            item.amount = row.amount.toString();
            item.unitPrice = row.unitPrice.toString();
            item.currency = row.currency;
        }
        return item;
    }

    /**
     * The order's serialized units.
     *
     * The allocated SKU (`order.skuId`) and the reservations are two views of
     * the same thing at different lifecycle points, so they are merged into
     * one list keyed by SKU: allocation wins over a hold for the same unit,
     * which is what makes "3 units, 1 allocated, 2 still held" render as three
     * rows rather than five.
     */
    private toSkuUnits(order: OrderDetailRow): OrderSkuUnit[] {
        const units = new Map<string, OrderSkuUnit>();

        for (const reservation of order.inventoryReservations) {
            const { sku } = reservation;
            units.set(sku.id, {
                skuId: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                allocation: reservation.status === 'COMMITTED' ? 'ALLOCATED' : reservation.status === 'HELD' ? 'HELD' : 'RELEASED',
                claimedStatus: sku.claimedStatus,
                tagId: sku.tagId,
                tagLifecycleState: sku.tagLifecycleState,
                ownerId: sku.ownerId,
                resaleBlocked: sku.resaleBlocked,
                reservationId: reservation.id,
                reservationExpiresAt: reservation.expiresAt.toISOString(),
            });
        }

        if (order.sku) {
            const { sku } = order;
            units.set(sku.id, {
                skuId: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                allocation: 'ALLOCATED',
                claimedStatus: sku.claimedStatus,
                tagId: sku.tagId,
                tagLifecycleState: sku.tagLifecycleState,
                ownerId: sku.ownerId,
                resaleBlocked: sku.resaleBlocked,
                reservationId: units.get(sku.id)?.reservationId ?? null,
                reservationExpiresAt: units.get(sku.id)?.reservationExpiresAt ?? null,
            });
        }

        return [...units.values()].sort((a, b) => a.serialNumber - b.serialNumber);
    }
}

export { OrderStatus };
