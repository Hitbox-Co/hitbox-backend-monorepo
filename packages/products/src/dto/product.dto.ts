import { z } from 'zod';
import { ComplianceStatus, DropStatus } from '@hitbox/database';
import {
    DEFAULT_PRODUCT_GROUP_CODE,
    PRODUCT_CODE_GROUP_LENGTH,
} from '../constants/products.constant';

/**
 * Catalog DTOs.
 *
 * `vertical`, `category` and `rarity` are free-form `String?` columns in the
 * schema, not enums — the old `ProductType` / `ProductCategory` /
 * `ProductGenre` / `ProductRarity` enums were removed in the catalog
 * restructure. They are validated here as bounded strings rather than against
 * a fixed set, because the database no longer constrains them and a list kept
 * only in TypeScript would be a second source of truth that silently drifts.
 *
 * `genre` is gone entirely and has no replacement column.
 */

// ── Queries ─────────────────────────────────────────────────────────────

/** A free-form catalog facet: short, trimmed, non-empty. */
const facet = z.string().trim().min(1).max(64);

export const listProductsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    category: facet.optional(),
    vertical: facet.optional(),
    rarity: facet.optional(),
    status: z.nativeEnum(DropStatus).optional(),
    collectionId: z.string().uuid().optional(),
    artistId: z.string().uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    // Price sorting is not expressible against the market-scoped
    // ProductPrice table — see PRODUCT_SORTS in the repository.
    sort: z.enum(['newest', 'popular']).default('newest'),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ── Mutations ───────────────────────────────────────────────────────────

export const createProductSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    vertical: facet.optional(),
    category: facet.optional(),
    rarity: facet.optional(),
    collectionId: z.string().uuid().optional(),
    artistId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
    /** Number of serialized SKUs that will exist for this drop. */
    totalSupply: z.number().int().min(0).default(0),
    /** Max units one buyer may purchase; omit for unlimited. */
    purchaseLimit: z.number().int().positive().optional(),
    releaseStart: z.coerce.date().optional(),
    releaseEnd: z.coerce.date().optional(),
    /** New drops start in DRAFT; the releases module drives the rest. */
    status: z.nativeEnum(DropStatus).default(DropStatus.DRAFT),
    isAgeSpecific: z.boolean().default(false),
    minimumAge: z.number().int().min(0).max(120).optional(),
    /** Pointer to the published odds disclosure (required for randomised drops). */
    oddsDisclosureRef: z.string().max(500).optional(),
    /** 4 trailing digits of the group code identifying the product group. */
    groupCode: z
        .string()
        .regex(new RegExp(`^\\d{${PRODUCT_CODE_GROUP_LENGTH}}$`), 'Must be 4 digits')
        .default(DEFAULT_PRODUCT_GROUP_CODE),
});

export type CreateProductDto = z.infer<typeof createProductSchema>;

/**
 * `groupCode` is omitted: it is the product's unique identifier, generated
 * once at creation. `complianceStatus` is omitted too — it is written by the
 * releases module's reviewer, not by a catalog edit.
 */
export const updateProductSchema = createProductSchema
    .omit({ groupCode: true })
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

export { ComplianceStatus, DropStatus };
