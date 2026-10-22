import { OrderStatus } from '@hitbox/database';
import { z } from 'zod';
import { ORDERS_DEFAULT_LIMIT, ORDERS_MAX_LIMIT } from '../constants/orders.constant';
import { ADMIN_SETTABLE_STATUSES } from '../domain/order-status';
import type { OrderMoneySummary } from '../domain/order-money';
import type { ShipmentView, StatusHistoryView } from './order-shipment.dto';

export const listOrdersQuerySchema = z.object({
    status: z.nativeEnum(OrderStatus).optional(),
    marketId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
    /** Matches the buyer's email, case-insensitively. */
    buyerEmail: z.string().trim().min(1).max(255).optional(),
    /** Matches `Product.groupCode` exactly. */
    productCode: z.string().trim().min(1).max(64).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(ORDERS_MAX_LIMIT).default(ORDERS_DEFAULT_LIMIT),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/**
 * Changing an order's status.
 *
 * `PAID` and `REFUNDED` are absent from the enum on purpose — they are written
 * by the payments and refund pipelines respectively, and an operator typing
 * them by hand would decouple the order from the transaction that justifies
 * it. See `ORDER_STATUS_TRANSITIONS`.
 */
export const changeOrderStatusSchema = z
    .object({
        status: z.enum(
            ADMIN_SETTABLE_STATUSES as [OrderStatus, ...OrderStatus[]],
        ),
        /** Carrier / waybill note, surfaced on the order detail. */
        trackingNote: z.string().trim().max(500).optional(),
        /** Why — recorded on the audit event, required for a cancellation. */
        reason: z.string().trim().max(500).optional(),
    })
    .strict()
    .refine(
        (value) => value.status !== OrderStatus.CANCELLED || Boolean(value.reason),
        { message: 'A reason is required when cancelling an order.', path: ['reason'] },
    );
export type ChangeOrderStatusDto = z.infer<typeof changeOrderStatusSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

/**
 * One order in the list.
 *
 * `buyerEmail` replaces the old opaque `buyerId`, and `productCode` replaces
 * `productId` — an operator scanning this table is looking for a person and a
 * drop, and a pair of UUIDs answers neither question without a second lookup.
 * The ids are still returned alongside, because that is what the detail route
 * and every other API key on.
 *
 * Both substituted fields are permission-gated: `buyerEmail` needs
 * `buyer-profile:read`, money needs `payment-royalty:read`.
 */
export interface OrderListItem {
    id: string;
    status: OrderStatus;
    quantity: number;
    productId: string;
    productCode: string;
    productName: string;
    variantId: string | null;
    skuId: string | null;
    marketId: string | null;
    organizationId: string | null;
    placedAt: string;
    shippedAt: string | null;
    deliveredAt: string | null;
    /**
     * When a packer scanned and confirmed the physical unit. Null = `skuId` is
     * still provisional (the unit held at checkout) — see
     * docs/orders/order-unit-assignment-api.md. The order cannot ship until set.
     */
    unitAssignedAt: string | null;

    /** Only with `buyer-profile:read`. */
    buyerId?: string;
    buyerEmail?: string;
    buyerName?: string | null;

    /** Only with `payment-royalty:read`. */
    amount?: string;
    unitPrice?: string;
    currency?: string;
}

/** One serialized unit attached to an order — allocated or merely held. */
export interface OrderSkuUnit {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    /** `ALLOCATED` once the SKU is the order's; `HELD` while it is a reservation. */
    allocation: 'ALLOCATED' | 'HELD' | 'RELEASED';
    claimedStatus: string;
    tagId: string | null;
    tagLifecycleState: string;
    ownerId: string | null;
    resaleBlocked: boolean;
    reservationId: string | null;
    reservationExpiresAt: string | null;
}

export interface OrderAddressView {
    usage: string;
    label: string;
    labelCustom: string | null;
    recipientName: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string;
    countryCode: string;
    phone: string | null;
}

export interface OrderDetail extends OrderListItem {
    gateway: string;
    trackingNote: string | null;
    termsAcceptedAt: string | null;
    updatedAt: string;
    archivedAt: string | null;
    market: { id: string; code: string; name: string; currency: string } | null;
    /**
     * Serialized units. An order for quantity 3 shows three rows once payment
     * settles; before that it shows its held reservations, which is what makes
     * "why has this not shipped" answerable.
     */
    skuUnits: OrderSkuUnit[];
    addresses: OrderAddressView[];
    /**
     * Which statuses this order may move to through `PATCH …/status` right
     * now. Drives the UI. SHIPPED is never listed — an order ships by
     * recording its shipment (`canRecordShipment`).
     */
    allowedTransitions: OrderStatus[];
    /** PROCESSING, unit scanned, no shipment yet → show "Ship (add tracking)". */
    canRecordShipment: boolean;
    /** SHIPPED with a shipment → show "Correct tracking". */
    canCorrectShipment: boolean;
    /** The live shipment (carrier + tracking number), or null. */
    shipment: ShipmentView | null;
    /** Every shipment, newest first, including VOIDED corrections. */
    shipments: ShipmentView[];
    /** Every status the order has been in, oldest first — the order timeline. */
    history: StatusHistoryView[];

    /** When payment settled. Null until PAID. */
    paidAt: string | null;
    /** Who scanned the unit at packing (docs/orders/order-unit-assignment-api.md). */
    unitAssignedById: string | null;

    /**
     * Only with `payment-royalty:read` — see
     * docs/orders/order-payments-and-refunds-api.md.
     */
    money?: OrderMoneySummary;
    /** Only with `payment-royalty:read`. Newest first. */
    payments?: {
        id: string;
        status: string;
        gateway: string;
        /** The provider's charge id, e.g. Stripe `pi_…`. */
        gatewayRef: string | null;
        amount: string;
        currency: string;
        needsReview: boolean;
        reviewedAt: string | null;
        reviewNote: string | null;
        failureReason: string | null;
        createdAt: string;
        updatedAt: string;
    }[];
    /** Only with `payment-royalty:read`. Newest first. */
    refunds?: {
        id: string;
        status: string;
        reasonCode: string;
        reason: string | null;
        amount: string | null;
        currency: string | null;
        physicalReturnRequired: boolean;
        physicalReturnConfirmedAt: string | null;
        nfcTagCondition: string | null;
        approvedAt: string | null;
        rejectionReason: string | null;
        /** The provider's refund id, e.g. Stripe `re_…`. */
        gatewayRefundId: string | null;
        /** Stripe's view of the money: PENDING / SUCCEEDED / FAILED / CANCELED, or null. FAILED on a PROCESSED refund = buyer not paid. */
        gatewayStatus: string | null;
        gatewayFailureReason: string | null;
        gatewayStatusAt: string | null;
        processedAt: string | null;
        claimRevokedAt: string | null;
        createdAt: string;
        updatedAt: string;
    }[];
}
