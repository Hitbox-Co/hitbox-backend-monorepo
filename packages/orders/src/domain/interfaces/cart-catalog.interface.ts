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
    price: { amount: string; currency: string; isFree: boolean } | null;
    totalSupply: number;
    mintedCount: number;
    rewardPoints: number;
    status: string;
    isViewable: boolean;
    /** Whether `POST /checkout` would accept it right now (stock aside). */
    isPurchasable: boolean;
    /** REMOVED | NOT_ON_SALE | NOT_RELEASED_YET | CLOSED | NO_PRICE; null when purchasable. */
    unavailableReason: string | null;
    variants: { id: string; label: string; isActive: boolean }[];
}

/**
 * Port implemented by the products module (`DropCardLookupAdapter`) and
 * injected at bootstrap.
 */
export interface ICartCatalog {
    /** Cards for `ids`, in any order. Unknown ids are absent. */
    findCards(ids: string[]): Promise<CartDropCard[]>;
}
