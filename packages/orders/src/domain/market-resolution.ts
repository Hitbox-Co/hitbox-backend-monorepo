/**
 * Which market's price applies when the app did not say.
 *
 * This is the server's BACKUP: the app should send `marketId` itself (the
 * buyer's chosen market, or the one for their address country). Only when it
 * does not do we guess, and we guess by rule, never by "newest price row".
 *
 * Order, among the markets this drop is actually priced in right now:
 *   1. the only one, when there is just one: nothing to choose;
 *   2. the buyer's saved preferred market;
 *   3. the market covering the billing address country, then the shipping one;
 *   4. the platform's default market.
 * Nothing matches: `null`, and the caller refuses (a drop priced in several
 * markets, none of which is the buyer's, is never silently charged in one of
 * them: regional prices are fixed, not converted).
 */
export interface MarketResolutionInput {
    /** Markets with an active price for this drop (and variant) right now. */
    pricedMarketIds: readonly string[];
    preferredMarketId: string | null;
    /** Billing first, then shipping. Already mapped from country to market. */
    addressMarketIds: readonly (string | null)[];
    defaultMarketId: string | null;
}

export type MarketSource = 'ONLY_PRICED' | 'PREFERRED' | 'ADDRESS' | 'DEFAULT';

export interface MarketResolution {
    marketId: string;
    source: MarketSource;
}

export function chooseMarket(input: MarketResolutionInput): MarketResolution | null {
    const priced = new Set(input.pricedMarketIds);
    if (priced.size === 0) return null;
    if (priced.size === 1) return { marketId: [...priced][0]!, source: 'ONLY_PRICED' };

    if (input.preferredMarketId && priced.has(input.preferredMarketId)) {
        return { marketId: input.preferredMarketId, source: 'PREFERRED' };
    }
    for (const id of input.addressMarketIds) {
        if (id && priced.has(id)) return { marketId: id, source: 'ADDRESS' };
    }
    if (input.defaultMarketId && priced.has(input.defaultMarketId)) {
        return { marketId: input.defaultMarketId, source: 'DEFAULT' };
    }
    return null;
}
