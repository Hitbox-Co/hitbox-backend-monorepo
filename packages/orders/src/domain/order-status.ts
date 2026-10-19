import { OrderStatus } from '@hitbox/database';

/**
 * Which status an order may move to, from each status it can be in.
 *
 * The lifecycle is a directed graph, not a free-for-all. Encoding it here
 * rather than accepting whatever the client sends is the difference between
 * "mark this delivered" and "silently un-refund a refunded order" — the
 * second is a money bug, and the API is the only place that can refuse it.
 *
 * Deliberate omissions:
 *
 *   • **Nothing leaves `REFUNDED`.** It is terminal. Money has moved back to
 *     the buyer and the order record must stay the evidence of that.
 *   • **Nothing leaves `DELIVERED` except `REFUNDED`.** A delivered order can
 *     still be refunded; it cannot go back to being in transit.
 *   • **`PAID` is not settable by hand.** It is written by the payments module
 *     when a transaction settles. Letting an operator type it would decouple
 *     the order from the payment that justifies it.
 *   • **`REFUNDED` is not settable by hand** for the same reason — the refund
 *     pipeline owns it. It appears as a *source* state only.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.CANCELLED],
    [OrderStatus.PAID]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
    [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
    [OrderStatus.DELIVERED]: [],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.REFUNDED]: [],
};

/** Statuses an administrator may set through the admin API. */
export const ADMIN_SETTABLE_STATUSES: OrderStatus[] = [
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Timestamps that must be stamped when entering a status.
 *
 * Kept beside the transition table because the two are one rule: an order
 * that is SHIPPED but carries no `shippedAt` is a record that cannot answer
 * "when did this ship", which is the first question a support case asks.
 */
export function timestampsFor(to: OrderStatus, now: Date): Record<string, Date> {
    switch (to) {
        case OrderStatus.SHIPPED:
            return { shippedAt: now };
        case OrderStatus.DELIVERED:
            return { deliveredAt: now };
        default:
            return {};
    }
}
