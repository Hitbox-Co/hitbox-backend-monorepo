import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { DropCard } from './drop-card';
import { toDropCard } from './drop-card';
import type { UnavailableReason } from './drop-visibility';
import { isPubliclyViewable, unavailableReason } from './drop-visibility';
import type { ProductRepository } from '../repository/product.repository';

/** A drop card with its state — what a wishlist row or a cart row renders. */
export interface DropCardWithState extends DropCard {
    status: string;
    /** Whether `GET /products/:id` would show it. */
    isViewable: boolean;
    /** Whether `POST /checkout` would accept it right now (stock aside). */
    isPurchasable: boolean;
    unavailableReason: UnavailableReason | null;
    /** Non-archived variants, in display order. Empty for a drop without variants. */
    variants: { id: string; label: string; isActive: boolean }[];
}

/**
 * Products-side adapter for the social module's wishlist port and the orders
 * module's cart port. Both consumers declare their own port; this one adapter
 * satisfies both structurally (same pattern as IMediaUrlResolver).
 */
export class DropCardLookupAdapter {
    constructor(
        private readonly products: ProductRepository,
        private readonly mediaUrls?: IMediaUrlResolver | undefined,
    ) { }

    /** Cards for `ids`, in no particular order. Unknown ids are simply absent. */
    async findCards(ids: string[], marketId?: string | null): Promise<DropCardWithState[]> {
        const rows = await this.products.findCardsByIds([...new Set(ids)]);
        // Only a usable (active) market counts; anything else is ignored.
        const market = await this.products.activeMarketId(marketId);
        const now = new Date();
        return rows.map((row) => {
            const card = toDropCard(row, this.mediaUrls, null, market);
            let reason = unavailableReason({ ...row, hasPrice: card.price !== null }, now);
            // With a region selected, "no price" means "not sold in this region".
            if (market && reason === 'NO_PRICE') reason = 'NOT_AVAILABLE_IN_REGION';
            return {
                ...card,
                // The owner of a wishlist/cart is the viewer; the consumer sets this.
                isWishlisted: null,
                status: row.status,
                isViewable: isPubliclyViewable(row),
                isPurchasable: reason === null,
                unavailableReason: reason,
                variants: row.dropVariants,
            };
        });
    }
}
