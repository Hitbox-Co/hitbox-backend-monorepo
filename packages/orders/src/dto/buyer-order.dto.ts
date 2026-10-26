import { z } from 'zod';
import type { BuyerTrackingView } from './order-shipment.dto';

/**
 * The buyer's own orders — docs/orders/buyer-orders-api.md.
 *
 * Everything here is shaped for a shopper, not an operator: no staff ids, no
 * gateway references, no internal notes, and every money field already in the
 * order's own currency.
 */

/** Tabs on "My orders". */
export const BUYER_ORDER_TABS = {
    /** Not finished yet: awaiting payment, confirmed, being packed, on its way. */
    active: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'],
    completed: ['DELIVERED'],
    /** Cancelled before it shipped, or refunded. */
    cancelled: ['CANCELLED', 'REFUNDED'],
} as const;
export type BuyerOrderTab = keyof typeof BUYER_ORDER_TABS | 'all';

export const listBuyerOrdersQuerySchema = z.object({
    tab: z.enum(['all', 'active', 'completed', 'cancelled']).default('all'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ListBuyerOrdersQuery = z.infer<typeof listBuyerOrdersQuerySchema>;

export const cancelBuyerOrderSchema = z.object({
    reason: z.string().trim().max(500).optional(),
});
export type CancelBuyerOrderDto = z.infer<typeof cancelBuyerOrderSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

/** Plain-English status, so every client says the same thing. */
export const BUYER_STATUS_LABELS: Record<string, string> = {
    PENDING_PAYMENT: 'Awaiting payment',
    PAID: 'Order confirmed',
    PROCESSING: 'Being packed',
    SHIPPED: 'Shipped',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    REFUNDED: 'Refunded',
};

export interface BuyerOrderProduct {
    id: string;
    name: string;
    code: string;
    /** Primary product image; null when the drop has none (or media is not configured). */
    imageUrl: string | null;
    artistName: string | null;
}

export interface BuyerOrderListItem {
    id: string;
    /** Short reference to show the buyer (`odr…`). Quote this to support. */
    reference: string | null;
    status: string;
    statusLabel: string;
    placedAt: string;
    deliveredAt: string | null;
    product: BuyerOrderProduct;
    /** e.g. "M / Black". Null for a drop without variants. */
    variantLabel: string | null;
    quantity: number;
    amount: string;
    currency: string;
    /** Once shipped. */
    tracking: { carrierName: string; trackingNumber: string; trackingUrl: string | null } | null;
    /** A refund is open on this order (requested, awaiting the return, or approved). */
    refundInProgress: boolean;
}

export interface BuyerOrderList {
    page: number;
    limit: number;
    total: number;
    /** Badge counts for every tab, whichever tab was asked for. */
    counts: { all: number; active: number; completed: number; cancelled: number };
    items: BuyerOrderListItem[];
}

export interface BuyerAddress {
    recipientName: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string;
    countryCode: string;
    phone: string | null;
}

export interface BuyerOrderRefund {
    id: string;
    /** REQUESTED, AWAITING_RETURN, APPROVED, PROCESSED, REJECTED */
    status: string;
    statusLabel: string;
    reasonCode: string;
    reason: string;
    amount: string | null;
    currency: string;
    requestedAt: string;
    /** The item must be sent back before the refund is approved. */
    returnRequired: boolean;
    returnReceivedAt: string | null;
    rejectionReason: string | null;
    /** When HitBox sent the money back. Banks usually take 5–10 business days after this. */
    processedAt: string | null;
    /** True when the payment provider reported the refund failed — HitBox support will contact the buyer. */
    failed: boolean;
}

export interface BuyerOrderActions {
    /** Unpaid → `POST /orders/:orderId/cancel`. */
    canCancel: boolean;
    /** Unpaid and the hold is still live → `POST /checkout/:orderId/resume`. */
    canResumePayment: boolean;
    /** → `POST /refunds` with this orderId. */
    canRequestRefund: boolean;
    /**
     * Why not, when `canRequestRefund` is false: ORDER_NOT_REFUNDABLE,
     * REFUND_IN_PROGRESS, RETURN_WINDOW_CLOSED, FULLY_REFUNDED.
     */
    refundBlockedReason: string | null;
    /**
     * Last moment a return can be placed (delivery + RETURN_WINDOW_DAYS).
     * Null until the order is delivered — the window hasn't started.
     */
    returnWindowEndsAt: string | null;
    /** A shipment exists → `GET /orders/:orderId/tracking` (also included below). */
    canTrack: boolean;
    /** An invoice exists → `GET /invoices/:invoiceId/download`. */
    canDownloadInvoice: boolean;
}

export interface BuyerOrderDetail extends Omit<BuyerOrderListItem, 'tracking' | 'refundInProgress'> {
    paidAt: string | null;
    shippedAt: string | null;
    variant: {
        id: string;
        label: string;
        options: { dimension: string; value: string; hexCode: string | null }[];
    } | null;
    /**
     * The numbered physical piece, once it has been packed. Before that the
     * order is for "one of" the edition and no number is promised.
     */
    unit: {
        skuCode: string;
        serialNumber: number;
        /** The buyer has tapped the tag and owns it on the provenance ledger. */
        claimed: boolean;
        claimedAt: string | null;
    } | null;
    unitPrice: string;
    shippingAddress: BuyerAddress | null;
    billingAddress: BuyerAddress | null;
    payment: {
        /** AWAITING_PAYMENT, PAID, FAILED, REFUNDED, CANCELLED */
        status: string;
        paidAt: string | null;
        /** While awaiting payment: when the held piece is released. */
        payBy: string | null;
        /** The last failed attempt's reason, while unpaid. */
        failureReason: string | null;
    };
    /** Newest first. */
    refunds: BuyerOrderRefund[];
    tracking: BuyerTrackingView['shipment'];
    timeline: BuyerTrackingView['timeline'];
    invoice: { id: string; number: string; date: string; totalAmount: string; currency: string } | null;
    actions: BuyerOrderActions;
}
