export const ORDERS_MODULE = 'orders' as const;

export const ORDERS_ERROR_CODES = {
    NOT_FOUND: 'ORDERS_NOT_FOUND',
    /** The requested status is not reachable from the order's current one. */
    INVALID_TRANSITION: 'ORDERS_INVALID_TRANSITION',
    /** PAID / REFUNDED are written by the payments pipeline, never by hand. */
    STATUS_NOT_SETTABLE: 'ORDERS_STATUS_NOT_SETTABLE',
    /** The drop is not on sale: wrong status, not open yet, or closed. */
    NOT_PURCHASABLE: 'ORDERS_NOT_PURCHASABLE',
    /** Every unit is sold or held by another checkout. */
    OUT_OF_STOCK: 'ORDERS_OUT_OF_STOCK',
    /** No active price row exists for the buyer's market. */
    NO_PRICE: 'ORDERS_NO_PRICE',

    // ── Unit assignment (docs/orders/order-unit-assignment-api.md) ──────────
    /** The scanned tag / code / serial matches no unit. */
    UNIT_NOT_FOUND: 'ORDERS_UNIT_NOT_FOUND',
    /** The scanned unit is a different drop or variant than the order — wrong item picked. */
    WRONG_ITEM: 'ORDERS_WRONG_ITEM',
    /** The scanned unit can't be shipped: sold, held, claimed, inactive, blocked, untagged or tag not BOUND. */
    UNIT_UNAVAILABLE: 'ORDERS_UNIT_UNAVAILABLE',
    /** The order already has a confirmed unit; send `replace: true` to swap it. */
    UNIT_ALREADY_ASSIGNED: 'ORDERS_UNIT_ALREADY_ASSIGNED',
    /** The order is not waiting for a unit (not PAID / PROCESSING, or holds no stock). */
    NOT_ASSIGNABLE: 'ORDERS_NOT_ASSIGNABLE',
    /** Shipping an order whose unit was never scanned and confirmed. */
    UNIT_NOT_ASSIGNED: 'ORDERS_UNIT_NOT_ASSIGNED',
    /** A scan-first lookup found no order waiting for this unit's variant. */
    NO_WAITING_ORDER: 'ORDERS_NO_WAITING_ORDER',
    /** Two packers scanned at once and the other one won. */
    ASSIGN_CONFLICT: 'ORDERS_ASSIGN_CONFLICT',
} as const;

/** Reading the order list and detail. */
export const ORDER_READ_CAPABILITY = 'order:read' as const;
/** Changing an order's status. Fulfilment is an operator action, not a global-only one. */
export const ORDER_WRITE_CAPABILITY = 'order:manage' as const;
/** Money fields (`amount`, `unitPrice`, `currency`) are gated separately. */
export const ORDER_MONEY_CAPABILITY = 'payment-royalty:read' as const;
/** Buyer identity (`buyerEmail`) is gated separately again. */
export const ORDER_BUYER_CAPABILITY = 'buyer-profile:read' as const;

export const ORDERS_DEFAULT_LIMIT = 20;
export const ORDERS_MAX_LIMIT = 100;

export const ORDER_EVENTS = {
    STATUS_CHANGED: 'orders.order.status-changed',
    /** A physical unit was scanned and confirmed for an order at packing. */
    UNIT_ASSIGNED: 'orders.order.unit-assigned',
} as const;

/** Order statuses in which a unit may be scanned and assigned. */
export const UNIT_ASSIGNABLE_STATUSES = ['PAID', 'PROCESSING'] as const;
