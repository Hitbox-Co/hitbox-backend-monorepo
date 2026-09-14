export const ORDERS_MODULE = 'orders' as const;

export const ORDERS_ERROR_CODES = {
    NOT_FOUND: 'ORDERS_NOT_FOUND',
    /** The requested status is not reachable from the order's current one. */
    INVALID_TRANSITION: 'ORDERS_INVALID_TRANSITION',
    /** PAID / REFUNDED are written by the payments pipeline, never by hand. */
    STATUS_NOT_SETTABLE: 'ORDERS_STATUS_NOT_SETTABLE',
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
} as const;
