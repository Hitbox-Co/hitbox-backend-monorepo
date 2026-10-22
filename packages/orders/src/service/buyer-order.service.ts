import type { OrderStatus } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { ORDER_EVENTS, ORDERS_ERROR_CODES } from '../constants/orders.constant';
import type { IMediaUrlResolver } from '../domain/interfaces/media-url-resolver.interface';
import { buildMoneySummary } from '../domain/order-money';
import {
    BUYER_ORDER_TABS,
    BUYER_STATUS_LABELS,
} from '../dto/buyer-order.dto';
import type {
    BuyerAddress,
    BuyerOrderDetail,
    BuyerOrderList,
    BuyerOrderListItem,
    CancelBuyerOrderDto,
    ListBuyerOrdersQuery,
} from '../dto/buyer-order.dto';
import type {
    BuyerOrderDetailRow,
    BuyerOrderListRow,
    BuyerOrderRepository,
} from '../repository/buyer-order.repository';
import type { OrderWriteRepository } from '../repository/order-write.repository';

export interface BuyerOrderServiceDeps {
    orders: BuyerOrderRepository;
    writes: OrderWriteRepository;
    mediaUrls?: IMediaUrlResolver | undefined;
    eventBus: IEventBus;
    logger: Logger;
}

const REFUND_LABELS: Record<string, string> = {
    REQUESTED: 'Refund requested',
    AWAITING_RETURN: 'Waiting for your return',
    APPROVED: 'Refund approved',
    PROCESSED: 'Refunded',
    REJECTED: 'Refund declined',
};

/**
 * "My orders" — the buyer's own orders, and the one thing a buyer may do to
 * an order directly: cancel it before paying. Everything else a buyer does
 * with an order goes through the module that owns it (checkout and refunds in
 * payments, invoices in tax), and the detail tells the client which of those
 * are possible right now (`actions`). docs/orders/buyer-orders-api.md.
 *
 * Ownership is the whole authorization model here: an order that is not the
 * caller's is a 404, identical to one that does not exist.
 */
export class BuyerOrderService {
    constructor(private readonly deps: BuyerOrderServiceDeps) { }

    async list(buyerId: string, query: ListBuyerOrdersQuery): Promise<BuyerOrderList> {
        const statuses = query.tab === 'all' ? null : (BUYER_ORDER_TABS[query.tab] as readonly OrderStatus[]);
        const [{ total, items }, byStatus] = await Promise.all([
            this.deps.orders.list({
                buyerId,
                statuses,
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.deps.orders.countByStatus(buyerId),
        ]);

        const sum = (list: readonly string[]) => list.reduce((n, status) => n + (byStatus[status] ?? 0), 0);
        return {
            page: query.page,
            limit: query.limit,
            total,
            counts: {
                all: Object.values(byStatus).reduce((n, c) => n + c, 0),
                active: sum(BUYER_ORDER_TABS.active),
                completed: sum(BUYER_ORDER_TABS.completed),
                cancelled: sum(BUYER_ORDER_TABS.cancelled),
            },
            items: items.map((row) => this.toListItem(row)),
        };
    }

    async get(buyerId: string, orderId: string): Promise<BuyerOrderDetail> {
        const order = await this.deps.orders.findDetail(orderId);
        if (!order || order.buyerId !== buyerId) {
            throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        return this.toDetail(order);
    }

    /**
     * The buyer abandons a checkout. Only before paying: the hold is released
     * at once, so the piece goes back on sale for the next person instead of
     * waiting out the hold. A paid order is cancelled by requesting a refund.
     */
    async cancel(buyerId: string, orderId: string, dto: CancelBuyerOrderDto): Promise<BuyerOrderDetail> {
        const owner = await this.deps.orders.findOwner(orderId);
        if (!owner || owner.buyerId !== buyerId || owner.archivedAt) {
            throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        if (owner.status === 'CANCELLED') return this.get(buyerId, orderId); // double tap
        if (owner.status !== 'PENDING_PAYMENT') {
            throw AppError.badRequest(
                'This order has been paid. To cancel it, request a refund (POST /refunds) — ' +
                'if it has not shipped yet, no return is needed.',
                ORDERS_ERROR_CODES.CANCEL_REQUIRES_REFUND,
                { status: owner.status },
            );
        }

        const cancelled = await this.deps.writes.cancelUnpaid({
            orderId,
            now: new Date(),
            source: 'BUYER',
            actorId: buyerId,
            reason: dto.reason ?? 'Cancelled by the buyer before payment',
        });
        if (!cancelled) {
            // The payment landed a moment earlier. The order is paid now.
            throw AppError.conflict(
                'Your payment went through just now, so this order can no longer be cancelled this way. Request a refund instead.',
                ORDERS_ERROR_CODES.INVALID_TRANSITION,
            );
        }
        await this.deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
            orderId,
            from: 'PENDING_PAYMENT',
            to: 'CANCELLED',
            actorId: buyerId,
            reason: dto.reason ?? 'Cancelled by the buyer before payment',
        });
        this.deps.logger.info({ orderId, buyerId }, 'unpaid order cancelled by the buyer');
        return this.get(buyerId, orderId);
    }

    // ── mapping ─────────────────────────────────────────────────────────────

    private product(row: BuyerOrderListRow['drop']) {
        const ref = row.dropImages[0]?.asset.storageRef;
        return {
            id: row.id,
            name: row.name,
            code: row.groupCode,
            imageUrl: ref && this.deps.mediaUrls ? this.deps.mediaUrls.publicUrl(ref) : null,
            artistName: row.artist?.name ?? null,
        };
    }

    private toListItem(row: BuyerOrderListRow): BuyerOrderListItem {
        const shipment = row.shipments[0];
        return {
            id: row.id,
            reference: row.publicCode,
            status: row.status,
            statusLabel: BUYER_STATUS_LABELS[row.status] ?? row.status,
            placedAt: row.placedAt.toISOString(),
            deliveredAt: row.deliveredAt?.toISOString() ?? null,
            product: this.product(row.drop),
            variantLabel: row.variant?.label ?? null,
            quantity: row.quantity,
            amount: row.amount.toFixed(2),
            currency: row.currency,
            tracking: shipment
                ? { carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber, trackingUrl: shipment.trackingUrl }
                : null,
            // The list query only selects open refunds.
            refundInProgress: row.refundRequests.length > 0,
        };
    }

    private toDetail(order: BuyerOrderDetailRow): BuyerOrderDetail {
        const base = this.toListItem(order);
        const shipment = order.shipments[0] ?? null;
        const now = new Date();
        const hold = order.inventoryReservations[0] ?? null;
        const holdLive = hold !== null && hold.expiresAt > now;
        const address = (usage: 'SHIPPING' | 'BILLING'): BuyerAddress | null => {
            const a = order.orderAddresss.find((x) => x.usage === usage);
            return a
                ? {
                    recipientName: a.recipientName, line1: a.line1, line2: a.line2, city: a.city, state: a.state,
                    postalCode: a.postalCode, countryCode: a.countryCode, phone: a.phone,
                }
                : null;
        };

        // A buyer may raise a refund on their own order — the same rules the
        // refund endpoint applies (RefundService.request), minus the staff grant.
        const money = buildMoneySummary({
            orderStatus: order.status,
            orderAmount: order.amount,
            currency: order.currency,
            payments: order.paymentTransactions,
            refunds: order.refundRequests,
            callerCanRefund: true,
        });

        const timeline: { status: string; at: string }[] = [];
        for (const row of order.statusHistory) {
            if (timeline.at(-1)?.status === row.toStatus) continue;
            timeline.push({ status: row.toStatus, at: row.occurredAt.toISOString() });
        }

        // The numbered piece is only promised once a packer scanned it.
        const unit = order.sku && order.unitAssignedAt
            ? {
                skuCode: order.sku.skuCode,
                serialNumber: order.sku.serialNumber,
                claimed: order.claimId !== null && order.sku.ownerId === order.buyerId,
                claimedAt: order.claimId !== null && order.sku.ownerId === order.buyerId
                    ? order.claimedAt?.toISOString() ?? null
                    : null,
            }
            : null;

        const lastFailure = order.paymentTransactions.find((p) => p.status === 'FAILED');
        const paymentStatus =
            order.status === 'PENDING_PAYMENT' ? 'AWAITING_PAYMENT'
                : order.status === 'REFUNDED' ? 'REFUNDED'
                    : order.status === 'CANCELLED' ? (order.paidAt ? 'REFUNDED' : lastFailure ? 'FAILED' : 'CANCELLED')
                        : 'PAID';

        const { tracking: _tracking, refundInProgress: _open, ...rest } = base;
        return {
            ...rest,
            paidAt: order.paidAt?.toISOString() ?? null,
            shippedAt: order.shippedAt?.toISOString() ?? null,
            variant: order.variant
                ? {
                    id: order.variant.id,
                    label: order.variant.label,
                    options: order.variant.options.map((o) => ({ dimension: o.dimensionLabel, value: o.valueLabel, hexCode: o.hexCode })),
                }
                : null,
            unit,
            unitPrice: order.unitPrice.toFixed(2),
            shippingAddress: address('SHIPPING'),
            billingAddress: address('BILLING'),
            payment: {
                status: paymentStatus,
                paidAt: order.paidAt?.toISOString() ?? null,
                payBy: order.status === 'PENDING_PAYMENT' && holdLive ? hold.expiresAt.toISOString() : null,
                failureReason: order.status === 'PENDING_PAYMENT' || paymentStatus === 'FAILED' ? lastFailure?.failureReason ?? null : null,
            },
            refunds: order.refundRequests.map((r) => ({
                id: r.id,
                status: r.status,
                statusLabel: REFUND_LABELS[r.status] ?? r.status,
                reasonCode: r.reasonCode,
                reason: r.reason,
                amount: r.amount?.toFixed(2) ?? null,
                currency: r.currency ?? order.currency,
                requestedAt: r.createdAt.toISOString(),
                returnRequired: r.physicalReturnRequired,
                returnReceivedAt: r.physicalReturnConfirmedAt?.toISOString() ?? null,
                rejectionReason: r.rejectionReason,
                processedAt: r.processedAt?.toISOString() ?? null,
                failed: r.gatewayStatus === 'FAILED' || r.gatewayStatus === 'CANCELED',
            })),
            tracking: shipment
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
            invoice: order.invoice
                ? {
                    id: order.invoice.id,
                    number: order.invoice.invoiceNumber,
                    date: order.invoice.invoiceDate.toISOString(),
                    totalAmount: order.invoice.totalAmount.toFixed(2),
                    currency: order.invoice.currency,
                }
                : null,
            actions: {
                canCancel: order.status === 'PENDING_PAYMENT',
                canResumePayment: order.status === 'PENDING_PAYMENT' && holdLive,
                canRequestRefund: money.canRequestRefund,
                refundBlockedReason: money.refundBlockedReason,
                canTrack: shipment !== null,
                canDownloadInvoice: order.invoice !== null,
            },
        };
    }
}
