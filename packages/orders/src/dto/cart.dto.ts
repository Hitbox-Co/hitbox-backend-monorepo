import { z } from 'zod';
import type { CartDropCard } from '../domain/interfaces/cart-catalog.interface';

const uuid = z.string().uuid();

export const addCartItemSchema = z
    .object({
        productId: uuid,
        variantId: uuid.optional(),
    })
    .strict();

export const cartItemIdParamSchema = z.object({ itemId: uuid });

/** `?marketId=` on GET/POST /cart. Never an error: a bad, unknown or inactive id is ignored. */
export const cartMarketQuerySchema = z.object({ marketId: uuid.optional().catch(undefined) });

export type AddCartItemDto = z.infer<typeof addCartItemSchema>;

/** One cart row as the app receives it. */
export interface CartItemView {
    id: string;
    productId: string;
    variant: { id: string; label: string } | null;
    addedAt: string;
    /** Null only if the drop row itself is gone (drops are soft-deleted, so in practice never). */
    product: CartDropCard | null;
}

export interface CartView {
    items: CartItemView[];
    summary: {
        itemCount: number;
        /** Rows that `POST /checkout` would accept right now. */
        purchasableCount: number;
        /**
         * Sum of the purchasable rows' base prices, one entry per currency
         * (decimal strings, 2 places). Indicative only: checkout charges each
         * item separately, at the price for the buyer's market and variant.
         */
        subtotals: { currency: string; amount: string }[];
    };
}
