import { z } from 'zod';
import {
    MarketplaceStatus,
    ProductCategory,
    ProductGenre,
    ProductRarity,
    ProductType,
} from '@hitbox/database';
import {
    DEFAULT_PRODUCT_GROUP_CODE,
    PRODUCT_CODE_GROUP_LENGTH,
} from '../constants/products.constant';

// ── Queries ─────────────────────────────────────────────────────────────

export const listProductsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    category: z.nativeEnum(ProductCategory).optional(),
    genre: z.nativeEnum(ProductGenre).optional(),
    type: z.nativeEnum(ProductType).optional(),
    rarity: z.nativeEnum(ProductRarity).optional(),
    marketplaceStatus: z.nativeEnum(MarketplaceStatus).optional(),
    collectionId: z.string().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ── Mutations ───────────────────────────────────────────────────────────

const productImageSchema = z.object({
    title: z.string().max(255).optional(),
    description: z.string().optional(),
    url: z.string().url(),
});

export const createProductSchema = z.object({
    name: z.string().min(1).max(255),
    type: z.nativeEnum(ProductType),
    category: z.nativeEnum(ProductCategory),
    genre: z.nativeEnum(ProductGenre),
    description: z.string().optional(),
    rewardPoints: z.number().int().min(0).default(0),
    rarity: z.nativeEnum(ProductRarity).default(ProductRarity.COMMON),
    priceInDollars: z.number().nonnegative().default(0),
    inventoryUnit: z.number().int().min(0).default(0),
    marketplaceStatus: z.nativeEnum(MarketplaceStatus).optional(),
    collectionId: z.string().optional(),
    tagId: z.string().max(64).optional(),
    releaseDate: z.coerce.date().optional(),
    /** 4 trailing digits of the productCode identifying the product group. */
    groupCode: z
        .string()
        .regex(new RegExp(`^\\d{${PRODUCT_CODE_GROUP_LENGTH}}$`), 'Must be 4 digits')
        .default(DEFAULT_PRODUCT_GROUP_CODE),
    images: z.array(productImageSchema).max(10).default([]),
});

export type CreateProductDto = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
    .omit({ groupCode: true, images: true })
    .partial()
    .strict();

export type UpdateProductDto = z.infer<typeof updateProductSchema>;

// ── Response envelope ───────────────────────────────────────────────────

export interface PaginatedResult<T> {
    items: T[];
    meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}
