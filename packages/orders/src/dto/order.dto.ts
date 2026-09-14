import { OrderStatus } from '@hitbox/database';
import { z } from 'zod';
import { ORDERS_DEFAULT_LIMIT, ORDERS_MAX_LIMIT } from '../constants/orders.constant';
import { ADMIN_SETTABLE_STATUSES } from '../domain/order-status';

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
    /** Which statuses this order may move to right now. Drives the UI. */
    allowedTransitions: OrderStatus[];

    /** Only with `payment-royalty:read`. */
    payments?: {
        id: string;
        status: string;
        gateway: string;
        amount: string;
        currency: string;
        createdAt: string;
    }[];
    refunds?: {
        id: string;
        status: string;
        amount: string | null;
        currency: string | null;
        reason: string | null;
        createdAt: string;
    }[];
}
