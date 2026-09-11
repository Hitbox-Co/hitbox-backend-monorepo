import { z } from 'zod';
import { Visibility } from '@hitbox/database';
import {
    COLLECTIONS_DEFAULT_PAGE_SIZE,
    COLLECTIONS_MAX_PAGE_SIZE,
} from '../constants/collections.constant';
import type { IMediaUrlResolver } from '../domain/interfaces/media-url-resolver.interface';
import type { BuyerCollectionRow } from '../repository/buyer-collection.repository';

/**
 * `CollectionVisibility` became the shared `Visibility` enum (same PUBLIC /
 * PRIVATE values), and the `genre` filter is gone — `ProductGenre` was
 * removed from the schema in the catalog restructure with no replacement
 * column, so there is nothing left to filter on.
 */
export const listCollectionQuerySchema = z.object({
    visibility: z.nativeEnum(Visibility).optional(), // own-collection filter only
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
        visibility: z.nativeEnum(Visibility),
    })
    .strict();

export type UpdateVisibilityDto = z.infer<typeof updateVisibilitySchema>;

/**
 * Progress toward "completing" the collections the user has started.
 * owned = the user's items that belong to an ArtistCollection;
 * total = Σ maximumLimit of those collections; percentage = round(owned/total),
 * clamped to 0–100.
 */
export interface CollectionProgressDto {
    owned: number;
    total: number;
    percentage: number;
}

/** Stats section of the Collections screen (all derived by aggregation). */
export interface CollectionStatsDto {
    /** Count of the user's shelf rows. */
    totalClaimedItems: number;
    /** Distinct ArtistCollections the user has ≥1 product from. */
    totalArtistCollections: number;
    collectionProgress: CollectionProgressDto;
}

/**
 * One shelf item: the placement, the serialized SKU, and the product card.
 *
 * Three fields changed with the schema:
 *   - `totalClaimedNo` → `sku.serialNumber`, the item's real position in its
 *     edition rather than a denormalized counter that could drift.
 *   - `claimedStatus` moved from the product to the SKU, which is where
 *     custody actually lives.
 *   - `genre` and `rewardPoints` are gone; neither has a replacement column.
 */
export interface CollectionItemDto {
    id: string;
    visibility: Visibility;
    acquiredAt: Date;
    sku: {
        id: string;
        skuCode: string;
        /** Position within the edition — "#14 of 500". */
        serialNumber: number;
        claimedStatus: string;
    };
    product: {
        id: string;
        name: string;
        imageUrl: string | null;
        /** Free-form since the restructure; `ProductRarity` no longer exists. */
        rarity: string | null;
    };
}

export function toCollectionItem(
    row: BuyerCollectionRow,
    mediaUrls?: IMediaUrlResolver | undefined,
): CollectionItemDto {
    const { sku } = row;
    const storageRef = sku.product.productImages[0]?.asset.storageRef;
    return {
        id: row.id,
        visibility: row.visibility,
        acquiredAt: row.acquiredAt,
        sku: {
            id: sku.id,
            skuCode: sku.skuCode,
            serialNumber: sku.serialNumber,
            claimedStatus: sku.claimedStatus,
        },
        product: {
            id: sku.product.id,
            name: sku.product.name,
            imageUrl: storageRef ? (mediaUrls?.publicUrl(storageRef) ?? null) : null,
            rarity: sku.product.rarity,
        },
    };
}
