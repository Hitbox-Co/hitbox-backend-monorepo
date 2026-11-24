/**
 * Which market's base price a catalog response shows.
 *
 * Every drop row is read with the base price of EVERY active market and the
 * market is chosen here, at mapping time. That keeps the list and entity caches
 * market-independent (one cached row serves every `?marketId=`).
 *
 *   marketId given (callers pass it only once it is known to be an ACTIVE
 *   market, see `ProductRepository.activeMarketId`) → that market's price, or
 *   null when the drop is not priced there: the drop is not sold in that region.
 *   No marketId → the default market's price, exactly as before.
 *
 * There is deliberately NO fallback to another market's price when a market was
 * asked for: showing a USD price to someone who picked India would be a lie.
 */
export interface BasePriceRow {
    marketId?: string;
    market: { isDefault?: boolean };
}

export function pickBasePrice<T extends BasePriceRow>(
    prices: readonly T[],
    marketId?: string | null,
): T | null {
    if (marketId) return prices.find((price) => price.marketId === marketId) ?? null;
    // `?? true`: a row cached before this change holds only the default
    // market's price and carries no `isDefault`; it is the default one.
    return prices.find((price) => price.market.isDefault ?? true) ?? null;
}
