/**
 * The one synchronous question finance asks the orders module.
 *
 * Finance accrues royalties when a physical item is **claimed**, but the money
 * facts it needs — what the buyer actually paid, what the unit cost to make,
 * which market and currency the sale settled in — belong to the order, and the
 * order belongs to another module. Rather than reaching into the `Order` table
 * (which would make finance un-extractable the moment orders becomes a
 * service), finance declares the question and bootstrap injects the answer.
 *
 * Consumer defines the port, provider implements the adapter: the same shape
 * as `IAccountLookup` (auth ← users) and `IArtistCollectionStats`
 * (collections ← artist). See docs/hitbox-architecture.md §6.
 */

/** Everything an accrual needs to know about the sale behind a claim. */
export interface OrderRevenueSnapshot {
    orderId: string;
    /** PAID / PROCESSING / SHIPPED / DELIVERED — anything settled. */
    status: string;
    buyerId: string;
    organizationId: string | null;
    productId: string;
    /** For rule resolution; snapshotted from the product at accrual time. */
    collectionId: string | null;
    artistId: string | null;
    marketId: string | null;
    /** Decimal strings, never numbers. */
    grossRevenue: string;
    /** Null when the catalog carries no cost for this market. */
    costOfGoods: string | null;
    currency: string;
    quantity: number;
}

export interface IOrderRevenueSource {
    /**
     * The settled order that put this serialized unit in someone's hands, or
     * null if there is none.
     *
     * Null is an ordinary answer, not an error: a unit can be claimed without
     * an order behind it (a giveaway, a promotional send, a support
     * replacement), and those owe no royalty. The accrual path treats null as
     * "nothing to post" and says so in the log.
     */
    findAccruableOrderForSku(skuId: string): Promise<OrderRevenueSnapshot | null>;

    /** Same snapshot, by order id — used when reversing a posted accrual. */
    findOrderRevenue(orderId: string): Promise<OrderRevenueSnapshot | null>;
}
