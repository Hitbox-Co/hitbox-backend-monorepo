/**
 * What payments needs the orders module to do.
 *
 * The dependency runs payments → orders and only that way, which is why
 * checkout lives here rather than in orders: the order is the *record* of a
 * purchase, but the purchase itself starts with money. Orders implements this
 * adapter; bootstrap connects them; neither module imports the other.
 *
 * Every method is idempotent or guarded, because each one is reachable from a
 * webhook the provider may deliver more than once.
 */

export interface PlaceOrderInput {
    buyerId: string;
    productId: string;
    variantId?: string | null;
    marketId?: string | null;
    quantity: number;
    /** Seconds the serialized unit is held while the buyer pays. */
    holdSeconds: number;
    termsAccepted: boolean;
    shippingAddressId?: string | null;
    billingAddressId?: string | null;
}

export interface PlacedOrder {
    orderId: string;
    /** The unit being held for this order. */
    skuId: string;
    reservationId: string;
    organizationId: string | null;
    marketId: string | null;
    unitPrice: string;
    amount: string;
    currency: string;
    costOfGoods: string | null;
    expiresAt: string;
}

export interface IOrderLedger {
    /**
     * Creates the order and holds a unit for it, in one transaction.
     *
     * Throws rather than returning null on "sold out" or "no price for your
     * market": those are things the buyer needs told, with a reason, not an
     * empty result the caller has to guess at.
     */
    placeOrder(input: PlaceOrderInput): Promise<PlacedOrder>;

    /**
     * Settlement: order → PAID, reservation → COMMITTED, `skuId` assigned.
     * Returns false if the order was already settled (a redelivered webhook)
     * or if the hold had expired and the unit is gone.
     */
    markPaid(input: { orderId: string; settledAt: Date }): Promise<boolean>;

    /** Payment failed or was abandoned: order → CANCELLED, hold released. */
    markFailed(input: { orderId: string; reason: string }): Promise<boolean>;

    /** Refund completed: order → REFUNDED. */
    markRefunded(input: { orderId: string; refundedAt: Date }): Promise<boolean>;

    /** The money facts a refund or a chargeback needs. */
    findOrderSummary(orderId: string): Promise<{
        orderId: string;
        buyerId: string;
        status: string;
        organizationId: string | null;
        skuId: string | null;
        claimId: string | null;
        amount: string;
        currency: string;
        gateway: string;
    } | null>;

    /** Releases every hold that has passed its expiry. Returns how many. */
    releaseExpiredReservations(now: Date): Promise<number>;
}
