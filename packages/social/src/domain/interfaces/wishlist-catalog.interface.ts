/**
 * The drop card a wishlist row renders, plus its state. The same card as
 * Discover / Marketplace, declared here so this module does not depend on
 * products (same pattern as discover's and marketplace's ports).
 */
export interface WishlistDropCard {
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
export interface IWishlistCatalog {
    /** Cards for `ids`, in any order. Unknown ids are absent. */
    findCards(ids: string[]): Promise<WishlistDropCard[]>;
}
