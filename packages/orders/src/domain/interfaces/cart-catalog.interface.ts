/**
 * The drop card a cart row renders, plus whether it can be bought right now.
 * The same card as Discover / Marketplace, declared here so this module does
 * not depend on products.
 */
export interface CartDropCard {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    rarity: string | null;
    category: string | null;
    artist: { id: string; name: string; slug: string } | null;
    price: { amount: string; currency: string; isFree: boolean; marketId: string | null } | null;
    totalSupply: number;
    mintedCount: number;
    rewardPoints: number;
    status: string;
    isViewable: boolean;
    /** Whether `POST /checkout` would accept it right now (stock aside). */
    isPurchasable: boolean;
    /** REMOVED | NOT_ON_SALE | NOT_RELEASED_YET | CLOSED | NO_PRICE | NOT_AVAILABLE_IN_REGION; null when purchasable. */
    unavailableReason: string | null;
    variants: { id: string; label: string; isActive: boolean }[];
}

/**
 * Port implemented by the products module (`DropCardLookupAdapter`) and
 * injected at bootstrap.
 */
export interface ICartCatalog {
    /**
     * Cards for `ids`, in any order. Unknown ids are absent. `marketId` (optional)
     * selects the region: a drop with no active price there comes back with a
     * null price and `NOT_AVAILABLE_IN_REGION`. Absent, unknown or inactive: the
     * default market's price, as before.
     */
    findCards(ids: string[], marketId?: string | null): Promise<CartDropCard[]>;
}
