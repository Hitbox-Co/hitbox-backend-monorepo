import { z } from 'zod';
import { ComplianceStatus, DropStatus, DropPriceStatus } from '@hitbox/database';
import {
    DEFAULT_PRODUCT_GROUP_CODE,
    PRODUCT_CODE_GROUP_LENGTH,
    PRODUCT_CODE_UNIQUE_LENGTH,
    PRODUCT_IMAGE_MAX,
    PRODUCT_PRICE_MAX,
    SKU_INLINE_MINT_MAX,
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

// ── Input coercion ──────────────────────────────────────────────────────

/**
 * These wrappers exist because the strict versions produced a wall of 422s
 * against every real client.
 *
 * A browser form, an HTML input, a Postman collection and most HTTP clients
 * all send numbers and booleans as **strings**, and send a field the user left
 * blank as `""` or `null` rather than omitting it. None of that is a malformed
 * request — it is what "no value" looks like over the wire — so the schema
 * accepts it and normalises, instead of rejecting it and making the client
 * pre-clean its own payload.
 *
 * What is NOT relaxed: types that cannot be recovered unambiguously. A
 * non-numeric string is still an error, and an unknown enum value is still an
 * error. The goal is to stop rejecting well-meant input, not to stop
 * validating.
 */

/** A free-form catalog facet: short, trimmed. `""`/null normalise to null. */
const facet = z
    .union([z.string(), z.null()])
    .transform((value) => {
        const trimmed = value?.trim() ?? '';
        return trimmed === '' ? null : trimmed;
    })
    .pipe(z.string().max(64).nullable());

/** A facet in a query string, where null has no meaning. */
const facetQuery = z.string().trim().min(1).max(64);

/** Free text. `""` and `null` both mean "no value" and normalise to null. */
const optionalText = (max: number) =>
    z
        .union([z.string(), z.null()])
        .transform((value) => {
            const trimmed = value?.trim() ?? '';
            return trimmed === '' ? null : trimmed;
        })
        .pipe(z.string().max(max).nullable());

/**
 * A uuid reference. `""` normalises to `null`, and **null is preserved** —
 * on create it means "not set", on update it means "disconnect this relation",
 * and collapsing it to `undefined` would silently turn a detach into a no-op.
 */
const optionalUuid = z
    .union([z.string(), z.null()])
    .transform((value) => (value === '' || value == null ? null : value))
    .pipe(z.string().uuid().nullable());

/** An integer that tolerates `"500"`. Rejects `"abc"`, as it should. */
const int = (opts: { min?: number; max?: number } = {}) => {
    let schema = z.coerce.number().int();
    if (opts.min !== undefined) schema = schema.min(opts.min);
    if (opts.max !== undefined) schema = schema.max(opts.max);
    return schema;
};

/**
 * A boolean that tolerates `"true"` / `"false"` / `1` / `0`.
 *
 * Explicitly NOT `z.coerce.boolean()`, which is a trap: it applies
 * `Boolean(value)`, and `Boolean("false")` is `true` — so the single most
 * common wire representation of false would silently become true.
 */
const bool = z.union([
    z.boolean(),
    z.literal('true').transform(() => true),
    z.literal('false').transform(() => false),
    z.literal(1).transform(() => true),
    z.literal(0).transform(() => false),
    z.literal('1').transform(() => true),
    z.literal('0').transform(() => false),
]);

/** An enum that tolerates the lower-case spelling a UI select often sends. */
const upperEnum = <T extends Record<string, string>>(values: T) =>
    z
        .union([z.string(), z.null()])
        .transform((value) => value?.toUpperCase())
        .pipe(z.nativeEnum(values));

// ── Queries ─────────────────────────────────────────────────────────────

export const listProductsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    category: facetQuery.optional(),
    vertical: facetQuery.optional(),
    rarity: facetQuery.optional(),
    status: z.nativeEnum(DropStatus).optional(),
    collectionId: z.string().uuid().optional(),
    artistId: z.string().uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    // Price sorting is not expressible against the market-scoped
    // ProductPrice table — see PRODUCT_SORTS in the repository.
    sort: z.enum(['newest', 'popular']).default('newest'),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/** Paginates the serialized units embedded in the product detail response. */
export const productDetailQuerySchema = z.object({
    skuPage: z.coerce.number().int().min(1).default(1),
    skuLimit: z.coerce.number().int().min(1).max(200).default(50),
    claimedStatus: z.enum(['UNCLAIMED', 'CLAIMED', 'IN_TRANSFER', 'FLAGGED']).optional(),
});
export type ProductDetailQuery = z.infer<typeof productDetailQuerySchema>;

// ── Product images ──────────────────────────────────────────────────────

/**
 * One gallery placement.
 *
 * The image itself is a `MediaAsset` uploaded through
 * `POST /admin/media/upload-url`; this row only carries *where it sits* on the
 * product. That split is why `assetId` is the only required field — the file
 * already exists, this is arranging it.
 */
export const productImageInputSchema = z
    .object({
        assetId: z.string().uuid(),
        /**
         * Display order, 0-first. Omit and entries take the order they were
         * sent in; the server renumbers to a contiguous 0..n-1 range either
         * way, so gaps and duplicates from a drag-and-drop UI are harmless.
         */
        position: int({ min: 0, max: 999 }).optional(),
        /**
         * The card/hero image. Exactly one placement carries it: setting it on
         * a second entry clears the first, and if no entry claims it the
         * lowest position gets it — a product whose gallery has no primary
         * renders with no image at all on every listing surface.
         */
        isPrimary: bool.optional(),
        altText: optionalText(300).optional(),
    })
    .strict();
export type ProductImageInput = z.infer<typeof productImageInputSchema>;

/** `POST /admin/products/:id/images` — append to the gallery. */
export const attachProductImagesSchema = z
    .object({
        images: z.array(productImageInputSchema).min(1).max(PRODUCT_IMAGE_MAX),
    })
    .strict();
export type AttachProductImagesDto = z.infer<typeof attachProductImagesSchema>;

/**
 * `PUT /admin/products/:id/images` — replace the gallery wholesale.
 *
 * Replace rather than diff, for the same reason market country lists are
 * replaced: after a drag-and-drop reorder the client knows the final state and
 * not the sequence of moves that produced it. An empty array clears the
 * gallery, which is a legitimate thing to want and impossible to express with
 * a merge.
 */
export const replaceProductImagesSchema = z
    .object({
        images: z.array(productImageInputSchema).max(PRODUCT_IMAGE_MAX),
    })
    .strict();
export type ReplaceProductImagesDto = z.infer<typeof replaceProductImagesSchema>;

/** `PATCH /admin/products/:id/images/:imageId` — move or relabel one. */
export const updateProductImageSchema = z
    .object({
        position: int({ min: 0, max: 999 }).optional(),
        isPrimary: bool.optional(),
        altText: optionalText(300).optional(),
    })
    .strict();
export type UpdateProductImageDto = z.infer<typeof updateProductImageSchema>;

export interface ProductImageResponse {
    imageId: string;
    assetId: string;
    /** Renderable URL, or null when no bucket is configured on this deploy. */
    url: string | null;
    storageRef: string;
    position: number;
    isPrimary: boolean;
    altText: string | null;
    createdAt: string;
}

// ── Product prices ──────────────────────────────────────────────────────

/**
 * A money amount, as `Decimal(12, 2)` accepts it.
 *
 * Accepts a number or a numeric string and **keeps it as a string** all the
 * way to Prisma. A price that round-trips through a JavaScript float is a
 * price that can arrive as `1999.9999999999998`, and `Decimal(12, 2)` would
 * silently round it — on the column that decides what a buyer is charged.
 */
const money = z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(
        z
            .string()
            .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Up to 10 digits and 2 decimal places, not negative'),
    );

/**
 * One price point: an amount, in one market, optionally for one variant.
 *
 * **There is no `currency` field, deliberately.** The currency is the
 * market's (`Market.currency`). Accepting one here would let a drop be priced
 * in GBP inside a market that settles in INR, and no constraint in the schema
 * would catch it. The response tells you which currency you got.
 */
export const productPriceInputSchema = z
    .object({
        /** Identify the market by id… */
        marketId: z.string().uuid().optional(),
        /** …or by its short code (`IN`, `US`). Exactly one of the two. */
        marketCode: z.string().trim().min(2).max(12).optional(),
        /**
         * The amount, as a decimal string. Required unless `isFree`.
         * Omit for a free drop; sending both is a contradiction and refused.
         */
        amount: money.optional(),
        isFree: bool.default(false),
        /** Unit cost, so finance can compute margin without re-deriving it. */
        costOfGoods: money.optional(),
        /** `DISABLED` stages a price without making it live. */
        status: upperEnum(DropPriceStatus).default(DropPriceStatus.ACTIVE),
        /**
         * Price a specific variant instead of the product as a whole.
         * Omit for the base price, which is what a market-less feed shows.
         */
        variantId: z.string().uuid().optional(),
    })
    .strict()
    .refine((value) => (value.marketId === undefined) !== (value.marketCode === undefined), {
        message: 'Provide exactly one of marketId or marketCode',
        path: ['marketId'],
    })
    .refine((value) => value.isFree || value.amount !== undefined, {
        message: 'amount is required unless isFree is true',
        path: ['amount'],
    })
    .refine((value) => !value.isFree || value.amount === undefined, {
        message: 'A free price cannot also carry an amount',
        path: ['amount'],
    });
export type ProductPriceInput = z.infer<typeof productPriceInputSchema>;

/**
 * The `prices` array, with the two rules that make a price list coherent.
 *
 * `min(1)` is the compulsory-pricing rule: a drop with no price is not
 * sellable in any market, and creating one is almost always a half-finished
 * form rather than an intention.
 */
const priceList = z
    .array(productPriceInputSchema)
    .min(1, 'At least one market price is required')
    .max(PRODUCT_PRICE_MAX)
    .superRefine((prices, ctx) => {
        // The DB has @@unique([productId, variantId, marketId]); two rows for
        // the same pair would fail there with a constraint error naming
        // nothing useful. Catch it here where the index is known.
        const seen = new Set<string>();
        for (const [index, price] of prices.entries()) {
            const key = `${price.marketId ?? price.marketCode}::${price.variantId ?? ''}`;
            if (seen.has(key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [index],
                    message: 'Duplicate price for this market and variant',
                });
            }
            seen.add(key);
        }
    });

/** `PUT /admin/products/:id/prices` — replace the whole price list. */
export const setProductPricesSchema = z.object({ prices: priceList }).strict();
export type SetProductPricesDto = z.infer<typeof setProductPricesSchema>;

/** `PATCH /admin/products/:id/prices/:priceId` — edit one price point. */
export const updateProductPriceSchema = z
    .object({
        amount: money.optional(),
        isFree: bool.optional(),
        costOfGoods: money.nullish(),
        status: upperEnum(DropPriceStatus).optional(),
    })
    .strict()
    .refine((value) => !(value.isFree === true && value.amount !== undefined), {
        message: 'A free price cannot also carry an amount',
        path: ['amount'],
    });
export type UpdateProductPriceDto = z.infer<typeof updateProductPriceSchema>;

export interface ProductPriceResponse {
    priceId: string;
    marketId: string;
    marketCode: string;
    marketName: string;
    /** Inherited from the market — never supplied by the client. */
    currency: string;
    /** Decimal string. `"0"` when free, `null` when unpriced. */
    amount: string | null;
    isFree: boolean;
    costOfGoods: string | null;
    status: string;
    variantId: string | null;
    createdAt: string;
    updatedAt: string;
}

// ── Mutations ───────────────────────────────────────────────────────────

export const createProductSchema = z.object({
    name: z.string().trim().min(1).max(255),
    description: optionalText(5000).optional(),
    vertical: facet.optional(),
    category: facet.optional(),
    rarity: facet.optional(),
    collectionId: optionalUuid.optional(),
    artistId: optionalUuid.optional(),
    organizationId: optionalUuid.optional(),
    /** Number of serialized SKUs that will exist for this drop. */
    totalSupply: int({ min: 0 }).default(0),
    /** Max units one buyer may purchase; omit for unlimited. */
    purchaseLimit: int({ min: 1 }).nullish(),
    releaseStart: z.coerce.date().nullish(),
    releaseEnd: z.coerce.date().nullish(),
    /** New drops start in DRAFT; the releases module drives the rest. */
    status: upperEnum(DropStatus).default(DropStatus.DRAFT),
    isAgeSpecific: bool.default(false),
    minimumAge: int({ min: 0, max: 120 }).nullish(),
    /** Pointer to the published odds disclosure (required for randomised drops). */
    oddsDisclosureRef: optionalText(500).optional(),
    /**
     * The 4-digit **group suffix**, not the full product code.
     *
     * The server returns a 12-digit `groupCode` (8 random digits + this
     * suffix), so a client that round-trips the value it got back is sending
     * 12 digits — which is why the 12-digit form is accepted here and its last
     * four taken. Rejecting it produced a 422 that read "Must be 4 digits" at a
     * field the API had just handed the caller as 12.
     */
    groupCode: z
        .union([z.string(), z.number(), z.null()])
        .transform((value) => (value == null ? DEFAULT_PRODUCT_GROUP_CODE : String(value).trim()))
        .transform((value) =>
            value.length === PRODUCT_CODE_UNIQUE_LENGTH + PRODUCT_CODE_GROUP_LENGTH
                ? value.slice(-PRODUCT_CODE_GROUP_LENGTH)
                : value,
        )
        .pipe(
            z
                .string()
                .regex(
                    new RegExp(`^\\d{${PRODUCT_CODE_GROUP_LENGTH}}$`),
                    `Must be ${PRODUCT_CODE_GROUP_LENGTH} digits (the group suffix), ` +
                    `or the full ${PRODUCT_CODE_UNIQUE_LENGTH + PRODUCT_CODE_GROUP_LENGTH}-digit product code`,
                ),
        )
        .default(DEFAULT_PRODUCT_GROUP_CODE),
    /**
     * Mint the edition in the same request that creates the drop.
     *
     * Omit it to create a catalog entry with no units yet and mint later
     * through `POST /admin/products/:productId/skus`. When present, the
     * product and its units are written in one transaction — a drop can never
     * come into existence with a partially minted edition.
     *
     * There is deliberately no `tagIds` here. Binding a physical NFC tag needs
     * `nfc-tag-claim:manage`, which this route does not check (it checks
     * `drop:manage`), and a payload that quietly bound tags on behalf of a
     * caller who lacks that capability would be a hole in the one table the
     * platform's authenticity guarantee rests on. Mint tags through the skus
     * endpoint, which checks for it.
     *
     * There is no `variantId` either, for a duller reason: a drop being created
     * right now has no variants yet, so any id supplied here would necessarily
     * belong to a *different* product — and the foreign key would happily
     * accept it. Mint per variant through the skus endpoint, which checks that
     * the variant belongs to the drop.
     */
    skus: z
        .object({
            count: int({ min: 1, max: SKU_INLINE_MINT_MAX }),
        })
        .strict()
        .optional(),
    /**
     * Attach already-uploaded media as the drop's gallery.
     *
     * Each entry references a `MediaAsset` that was uploaded through
     * `POST /admin/media/upload-url` — this joins it to the product as a
     * `ProductImage`, in the same transaction as the product itself.
     */
    images: z.array(productImageInputSchema).max(PRODUCT_IMAGE_MAX).optional(),
    /**
     * Market pricing. **Required — at least one market price.**
     *
     * A drop with no price is not purchasable anywhere: the storefront reads
     * `ProductPrice` for the buyer's market, and with no row there is nothing
     * to show and nothing to charge. Every previous route to that state was a
     * half-finished form, so the API refuses to create one.
     *
     * One entry per market the drop sells in; the currency of each comes from
     * the market, not from here.
     */
    prices: priceList,
});

export type CreateProductDto = z.infer<typeof createProductSchema>;

/**
 * `groupCode` is omitted: it is the product's unique identifier, generated
 * once at creation. `complianceStatus` is omitted too — it is written by the
 * releases module's reviewer, not by a catalog edit.
 *
 * `skus`, `images` and `prices` are omitted because none of them is a scalar
 * edit, and letting them through this schema would pass them straight into
 * `product.update()` as if they were columns:
 *
 *   - **skus** — minting is not an edit. Units are physical objects with
 *     owners and provenance; "PATCH the product to say 600 now" has no meaning
 *     once 500 exist. Mint through the skus endpoint, which appends.
 *   - **images** — the gallery has cross-row invariants (contiguous order,
 *     exactly one primary). `PUT /admin/products/:id/images` owns it.
 *   - **prices** — repricing needs each market resolved and validated.
 *     `PUT /admin/products/:id/prices` owns it.
 */
export const updateProductSchema = createProductSchema
    .omit({ groupCode: true, skus: true, images: true, prices: true })
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

export { ComplianceStatus, DropStatus, DropPriceStatus };
