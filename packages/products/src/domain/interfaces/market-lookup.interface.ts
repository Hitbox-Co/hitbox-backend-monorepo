/**
 * Port: resolve the markets a price refers to.
 *
 * `ProductPrice` points at a `Market`, but markets are the markets module's
 * table. Setting a price needs three answers products cannot give itself: does
 * this market exist, is it live, and **what currency does it settle in** — the
 * last one especially, because the price row stores no currency of its own.
 *
 * That is the design decision worth understanding. A price is an amount plus a
 * market; the currency is read off the market. Storing a currency on the price
 * row would let a product be priced in GBP inside a market that settles in
 * INR, and nothing in the schema would object.
 *
 * Bootstrap connects @hitbox/markets as the implementation.
 */
export interface IMarketLookup {
    /**
     * Resolves by id or by code in one query. Operators type codes (`IN`,
     * `US`); a UI holds ids. Both cost the same round trip.
     */
    findManyByIdsOrCodes(ids: string[], codes: string[]): Promise<MarketRef[]>;
}

export interface MarketRef {
    id: string;
    /** Short stable key, e.g. `IN`. */
    code: string;
    name: string;
    /** `USD` | `INR` | `GBP` — the settlement currency the price inherits. */
    currency: string;
    isActive: boolean;
    isDefault: boolean;
    archivedAt: Date | null;
}
