/**
 * The drop card the set screen renders: the same card as Discover,
 * Marketplace and the wishlist, declared here so this module does not depend
 * on products (same pattern as the other consumer-owned ports).
 */
export interface CollectionDropCard {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    rarity: string | null;
    category: string | null;
    artist: { id: string; name: string; slug: string } | null;
    price: { amount: string; currency: string; isFree: boolean; marketId?: string | null } | null;
    totalSupply: number;
    mintedCount: number;
    rewardPoints: number;
    status: string;
    /** Whether `GET /products/:id` would show it. */
    isViewable: boolean;
    /** Whether `POST /checkout` would accept it right now (stock aside). */
    isPurchasable: boolean;
    unavailableReason: string | null;
    variants: { id: string; label: string; isActive: boolean }[];
}

/**
 * Port implemented by the products module (`DropCardLookupAdapter`) and
 * injected at bootstrap.
 */
export interface IDropCardCatalog {
    /**
     * Cards for `ids`, in any order. Unknown ids are absent. `marketId` picks
     * the market the price is shown in; unusable values are ignored.
     */
    findCards(ids: string[], marketId?: string | null): Promise<CollectionDropCard[]>;
}
