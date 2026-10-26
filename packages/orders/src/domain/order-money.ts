import { Prisma } from '@hitbox/database';

/**
 * An order's money at a glance — what was charged, collected and refunded,
 * how much more could be refunded, and whether a refund can be started now.
 *
 * Pure, so it is unit-testable and the rules sit in one place. The rules
 * mirror the payments module's RefundService.request exactly:
 *
 *  - only PAID / PROCESSING / SHIPPED / DELIVERED orders are refundable;
 *  - one refund at a time: none may be open (REQUESTED / AWAITING_RETURN /
 *    APPROVED);
 *  - refunds can never add up to more than the order was charged — only
 *    PROCESSED refunds count as money given back;
 *  - the return window: RETURN_WINDOW_DAYS after delivery, then closed. A
 *    closed window blocks the *buyer* from any refund on the delivered order;
 *    staff can still raise one with nothing sent back (a goodwill refund),
 *    so for them it only means "no return" — `returnWindowOpen` tells the UI
 *    to turn the "item must be returned" toggle off.
 *
 * docs/orders/order-payments-and-refunds-api.md §3.
 */

export const REFUNDABLE_ORDER_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
export const OPEN_REFUND_STATUSES = ['REQUESTED', 'AWAITING_RETURN', 'APPROVED'] as const;

export type RefundBlockedReason =
    | 'NO_PERMISSION'
    | 'ORDER_NOT_REFUNDABLE'
    | 'REFUND_IN_PROGRESS'
    | 'RETURN_WINDOW_CLOSED'
    | 'FULLY_REFUNDED';

/**
 * When the return window on a delivered order closes, or null while it has
 * not started (not delivered yet). Open strictly before that instant.
 */
export function returnWindowEndsAt(deliveredAt: Date | null, days: number): Date | null {
    return deliveredAt ? new Date(deliveredAt.getTime() + days * 86_400_000) : null;
}

export interface OrderMoneySummary {
    currency: string;
    /** What the order was charged (`Order.amount`). */
    charged: string;
    /** Sum of SUCCEEDED payment transactions. */
    paid: string;
    /** Sum of PROCESSED refunds the provider has not failed — money given back. */
    refunded: string;
    /**
     * PROCESSED refunds the provider then FAILED / CANCELED — the order says
     * refunded but the buyer has no money. Non-zero means an operator must act.
     */
    refundFailed: string;
    /** Amount of the open refund, if one is in progress; else "0.00". */
    refundInProgress: string;
    /** charged − refunded, never below zero. The most a new refund may ask for. */
    refundable: string;
    /** True when the caller can start a refund on this order right now. */
    canRequestRefund: boolean;
    /** Why not, when `canRequestRefund` is false. */
    refundBlockedReason: RefundBlockedReason | null;
    /** The open refund's id, so the UI can link to it. */
    openRefundId: string | null;
    /** When returns stop being accepted. Null until the order is delivered. */
    returnWindowEndsAt: string | null;
    /** True until `returnWindowEndsAt` — including before delivery. */
    returnWindowOpen: boolean;
}

type Money = Prisma.Decimal | string | number;

const ZERO = new Prisma.Decimal(0);
const toDec = (value: Money | null | undefined) => (value == null ? ZERO : new Prisma.Decimal(value));

export function buildMoneySummary(input: {
    orderStatus: string;
    orderAmount: Money;
    currency: string;
    payments: { status: string; amount: Money }[];
    refunds: { id: string; status: string; amount: Money | null; gatewayStatus?: string | null }[];
    /** `order:refund:global` — the grant RefundService requires to act for a buyer. */
    callerCanRefund: boolean;
    /** True on the buyer's own screens: a closed window blocks them outright. */
    callerIsBuyer?: boolean;
    deliveredAt?: Date | null;
    /** RETURN_WINDOW_DAYS. Defaults to 10. */
    returnWindowDays?: number;
    now?: Date;
}): OrderMoneySummary {
    const windowEnd = returnWindowEndsAt(input.deliveredAt ?? null, input.returnWindowDays ?? 10);
    const windowOpen = windowEnd === null || (input.now ?? new Date()) < windowEnd;
    const charged = toDec(input.orderAmount);
    const paid = input.payments
        .filter((p) => p.status === 'SUCCEEDED')
        .reduce((sum, p) => sum.plus(toDec(p.amount)), ZERO);
    const processed = input.refunds.filter((r) => r.status === 'PROCESSED');
    const failed = (r: { gatewayStatus?: string | null }) => r.gatewayStatus === 'FAILED' || r.gatewayStatus === 'CANCELED';
    const refunded = processed.filter((r) => !failed(r)).reduce((sum, r) => sum.plus(toDec(r.amount)), ZERO);
    const refundFailed = processed.filter(failed).reduce((sum, r) => sum.plus(toDec(r.amount)), ZERO);
    const open = input.refunds.find((r) => (OPEN_REFUND_STATUSES as readonly string[]).includes(r.status)) ?? null;
    // A failed refund still counts against what may be refunded, exactly as
    // RefundService's over-refund guard counts every PROCESSED refund: putting
    // it right is an operator decision, not a second refund request.
    const refundable = Prisma.Decimal.max(ZERO, charged.minus(refunded).minus(refundFailed));

    let blocked: RefundBlockedReason | null = null;
    if (!input.callerCanRefund) blocked = 'NO_PERMISSION';
    else if (!(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(input.orderStatus)) blocked = 'ORDER_NOT_REFUNDABLE';
    else if (open) blocked = 'REFUND_IN_PROGRESS';
    else if (input.callerIsBuyer && !windowOpen) blocked = 'RETURN_WINDOW_CLOSED';
    else if (refundable.lessThanOrEqualTo(0)) blocked = 'FULLY_REFUNDED';

    return {
        currency: input.currency,
        charged: charged.toFixed(2),
        paid: paid.toFixed(2),
        refunded: refunded.toFixed(2),
        refundFailed: refundFailed.toFixed(2),
        refundInProgress: open ? toDec(open.amount).toFixed(2) : '0.00',
        refundable: refundable.toFixed(2),
        canRequestRefund: blocked === null,
        refundBlockedReason: blocked,
        openRefundId: open?.id ?? null,
        returnWindowEndsAt: windowEnd?.toISOString() ?? null,
        returnWindowOpen: windowOpen,
    };
}
