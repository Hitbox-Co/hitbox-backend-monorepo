import { z } from 'zod';
import { CollectionVisibility, ProductGenre } from '@hitbox/database';
import {
    COLLECTIONS_DEFAULT_PAGE_SIZE,
    COLLECTIONS_MAX_PAGE_SIZE,
} from '../constants/collections.constant';
import type { BuyerCollectionRow } from '../repository/buyer-collection.repository';

export const listCollectionQuerySchema = z.object({
    genre: z.nativeEnum(ProductGenre).optional(),
    visibility: z.nativeEnum(CollectionVisibility).optional(), // own-collection filter only
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(COLLECTIONS_MAX_PAGE_SIZE)
        .default(COLLECTIONS_DEFAULT_PAGE_SIZE),
});

export type ListCollectionQueryDto = z.infer<typeof listCollectionQuerySchema>;

export const updateVisibilitySchema = z
    .object({
        visibility: z.nativeEnum(CollectionVisibility),
    })
    .strict();

export type UpdateVisibilityDto = z.infer<typeof updateVisibilitySchema>;

/** One shelf item on the Collections screen — collection row + product card. */
export interface CollectionItemDto {
    id: string;
    visibility: CollectionVisibility;
    totalClaimedNo: number;
    genre: ProductGenre | null;
    addedAt: Date;
    product: {
        id: string;
        name: string;
        imageUrl: string | null;
        rarity: string;
        rewardPoints: number;
        claimedStatus: string;
    };
}

export function toCollectionItem(row: BuyerCollectionRow): CollectionItemDto {
    return {
        id: row.id,
        visibility: row.visibility,
        totalClaimedNo: row.totalClaimedNo,
        genre: row.genre,
        addedAt: row.createdAt,
        product: {
            id: row.product.id,
            name: row.product.name,
            imageUrl: row.product.images[0]?.url ?? null,
            rarity: row.product.rarity,
            rewardPoints: row.product.rewardPoints,
            claimedStatus: row.product.claimedStatus,
        },
    };
}
