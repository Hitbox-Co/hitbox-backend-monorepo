export const PRODUCTS_MODULE = 'products' as const;

export const PRODUCTS_ERROR_CODES = {
    PRODUCT_NOT_FOUND: 'PRODUCTS_NOT_FOUND',
    PRODUCT_CODE_TAKEN: 'PRODUCTS_CODE_TAKEN',
    TAG_TAKEN: 'PRODUCTS_TAG_TAKEN',
    /** A `skus` block arrived but no minting provider is wired in. */
    MINTING_UNAVAILABLE: 'PRODUCTS_MINTING_UNAVAILABLE',
    /** `skus.count` exceeds the drop's own declared `totalSupply`. */
    SUPPLY_EXCEEDED: 'PRODUCTS_SUPPLY_EXCEEDED',
    /** An `images` block arrived but no asset-lookup provider is wired in. */
    MEDIA_UNAVAILABLE: 'PRODUCTS_MEDIA_UNAVAILABLE',
    /** One or more `assetId`s do not exist, are archived, or are not images. */
    IMAGE_ASSET_INVALID: 'PRODUCTS_IMAGE_ASSET_INVALID',
    /** The same asset was attached to this product twice. */
    IMAGE_DUPLICATE: 'PRODUCTS_IMAGE_DUPLICATE',
    IMAGE_NOT_FOUND: 'PRODUCTS_IMAGE_NOT_FOUND',
    /** A `prices` block arrived but no market-lookup provider is wired in. */
    MARKETS_UNAVAILABLE: 'PRODUCTS_MARKETS_UNAVAILABLE',
    /** One or more markets do not exist, are archived, or are inactive. */
    PRICE_MARKET_INVALID: 'PRODUCTS_PRICE_MARKET_INVALID',
    /** Refused: removing the last price would leave the drop unsellable. */
    PRICE_REQUIRED: 'PRODUCTS_PRICE_REQUIRED',
    PRICE_NOT_FOUND: 'PRODUCTS_PRICE_NOT_FOUND',
} as const;

/**
 * Reading the admin detail screen. Wider than the write gate: a Drop Manager
 * or Brand Admin needs to inspect a drop they cannot edit platform-wide.
 */
export const PRODUCT_READ_CAPABILITY = 'drop:read' as const;

/**
 * Catalog administration. Paired with `globalOnly` at the router, which is how
 * "system admin only" is expressed without inventing a resource: an org-scoped
 * `drop:manage:organization` holder manages their own drops elsewhere, not the
 * platform catalog.
 */
export const PRODUCT_WRITE_CAPABILITY = 'drop:manage' as const;

export const PRODUCT_EVENTS = {
    PRODUCT_CREATED: 'products.product.created',
    PRODUCT_UPDATED: 'products.product.updated',
    PRODUCT_ARCHIVED: 'products.product.archived',
} as const;

/**
 * `Product.groupCode` format: 8 unique digits + 4 group digits = 12 chars.
 *
 * The column was called `productCode` before the catalog restructure; the
 * format and its role as the public identifier are unchanged.
 */
export const PRODUCT_CODE_UNIQUE_LENGTH = 8;
export const PRODUCT_CODE_GROUP_LENGTH = 4;
export const DEFAULT_PRODUCT_GROUP_CODE = '0000';

/** Retries when a randomly generated groupCode collides. */
export const PRODUCT_CODE_MAX_ATTEMPTS = 5;

/**
 * Units mintable in the same request that creates the drop.
 *
 * Capped well below a large edition on purpose: this insert runs inside the
 * transaction that also creates the Product, and a transaction that writes
 * 10,000 rows holds locks for long enough to matter. Larger editions are minted
 * in batches through `POST /admin/products/:productId/skus`, which is the same
 * code path without the product write attached.
 */
export const SKU_INLINE_MINT_MAX = 1000;

/**
 * Images per drop.
 *
 * A gallery, not a media library — the drop page renders these, and a
 * hundred-image payload is a mistake rather than a requirement.
 */
export const PRODUCT_IMAGE_MAX = 24;

/**
 * Asset types accepted into a product gallery.
 *
 * `DROP_IMAGE` lives under the `drop-images/` prefix, which is the only
 * product-facing prefix with public read. Attaching an `EXCLUSIVE_CONTENT` or
 * `LEGAL_DOCUMENT` asset would produce a gallery entry whose URL 403s for
 * every shopper — so it is refused at attach time instead of rendering as a
 * broken image forever.
 */
export const PRODUCT_IMAGE_ASSET_TYPES = ['DROP_IMAGE'] as const;

/**
 * Price points per drop.
 *
 * One per (market, variant) pair. A drop selling in 3 markets with 8 variants
 * is 24 rows before the base prices, so the cap is generous — it exists to
 * stop a runaway payload, not to constrain real pricing.
 */
export const PRODUCT_PRICE_MAX = 200;


// ── Redis cache (cache-aside; see cache/product-cache.ts) ──────────────────
// Reads check Redis first and populate it on miss; any mutation (create,
// update, archive) invalidates. No-ops entirely when REDIS_URL is unset.

/** Single-product lookups (findById / findByGroupCode). */
export const PRODUCT_CACHE_ENTITY_TTL_SECONDS = 300; // 5 minutes

/** Paginated/listing queries (catalog list, discover feed, marketplace feed). */
export const PRODUCT_CACHE_LIST_TTL_SECONDS = 30; // 30 seconds

export const PRODUCT_CACHE_KEY_PREFIX = 'products' as const;
