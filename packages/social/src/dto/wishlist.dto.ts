import { z } from 'zod';
import {
    WISHLIST_DEFAULT_PAGE_SIZE,
    WISHLIST_MAX_PAGE_SIZE,
    WISHLIST_NOTE_MAX_LENGTH,
} from '../constants/social.constant';
import type { WishlistDropCard } from '../domain/interfaces/wishlist-catalog.interface';

const uuid = z.string().uuid();

export const listWishlistQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(WISHLIST_MAX_PAGE_SIZE).default(WISHLIST_DEFAULT_PAGE_SIZE),
});

export const addWishlistItemSchema = z
    .object({
        productId: uuid,
        variantId: uuid.optional(),
        notifyOnAvailable: z.boolean().optional(),
        note: z.string().trim().max(WISHLIST_NOTE_MAX_LENGTH).nullable().optional(),
    })
    .strict();

export const updateWishlistItemSchema = z
    .object({
        notifyOnAvailable: z.boolean().optional(),
        note: z.string().trim().max(WISHLIST_NOTE_MAX_LENGTH).nullable().optional(),
    })
    .strict()
    .refine((body) => body.notifyOnAvailable !== undefined || body.note !== undefined, {
        message: 'Send notifyOnAvailable and/or note',
    });

export const removeByProductQuerySchema = z.object({
    /** Remove only this variant's row; omitted = every row for the drop. */
    variantId: uuid.optional(),
});

export const itemIdParamSchema = z.object({ itemId: uuid });
export const productIdParamSchema = z.object({ productId: uuid });

export type ListWishlistQueryDto = z.infer<typeof listWishlistQuerySchema>;
export type AddWishlistItemDto = z.infer<typeof addWishlistItemSchema>;
export type UpdateWishlistItemDto = z.infer<typeof updateWishlistItemSchema>;

/** One wishlist row as the app receives it. */
export interface WishlistItemView {
    id: string;
    productId: string;
    /** The variant the buyer saved, or null for the drop as a whole. */
    variant: { id: string; label: string } | null;
    notifyOnAvailable: boolean;
    note: string | null;
    addedAt: string;
    /** Null only if the drop row itself is gone (it never is — drops are soft-deleted). */
    product: WishlistDropCard | null;
}
