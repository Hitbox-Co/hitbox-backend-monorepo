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
    /** Publishing a drop whose owner has not approved it. */
    NOT_APPROVED: 'PRODUCTS_NOT_APPROVED',
    /** Publishing a drop that is already live, or one that is archived. */
    NOT_PUBLISHABLE: 'PRODUCTS_NOT_PUBLISHABLE',
    /** Publishing a drop whose compliance evidence is incomplete. */
    PUBLISH_BLOCKED: 'PRODUCTS_PUBLISH_BLOCKED',
    /** The release gate is not wired in, so approval cannot be verified. */
    RELEASE_GATE_UNAVAILABLE: 'PRODUCTS_RELEASE_GATE_UNAVAILABLE',

    // ── Drop types & variants (docs/admin/drop-types-and-variants.md) ───────
    /** Unknown, or inactive, drop type code. */
    DROP_TYPE_NOT_FOUND: 'PRODUCTS_DROP_TYPE_NOT_FOUND',
    /** A drop type with this code already exists. */
    DROP_TYPE_CODE_TAKEN: 'PRODUCTS_DROP_TYPE_CODE_TAKEN',
    /** The type definition itself is invalid — bad rule, pattern, hex, duplicate code. */
    DROP_TYPE_INVALID: 'PRODUCTS_DROP_TYPE_INVALID',
    /** Changing something that drops already depend on (variantMode in use, a drop's type once it has variants). */
    DROP_TYPE_LOCKED: 'PRODUCTS_DROP_TYPE_LOCKED',
    DIMENSION_NOT_FOUND: 'PRODUCTS_DIMENSION_NOT_FOUND',
    DIMENSION_VALUE_NOT_FOUND: 'PRODUCTS_DIMENSION_VALUE_NOT_FOUND',
    /** Variant writes on a drop with no type — set `dropType` first. */
    DROP_TYPE_REQUIRED: 'PRODUCTS_DROP_TYPE_REQUIRED',
    /** Adding / removing variants outside DRAFT or REJECTED. */
    DROP_NOT_EDITABLE: 'PRODUCTS_DROP_NOT_EDITABLE',
    VARIANT_NOT_FOUND: 'PRODUCTS_VARIANT_NOT_FOUND',
    /** The combination already exists on this drop. */
    VARIANT_DUPLICATE: 'PRODUCTS_VARIANT_DUPLICATE',
    /** Options break the type's rules; `details.problems` lists each. */
    VARIANT_INVALID_OPTIONS: 'PRODUCTS_VARIANT_INVALID_OPTIONS',
    /** The drop's type has `variantMode = NONE`. */
    VARIANTS_NOT_ALLOWED: 'PRODUCTS_VARIANTS_NOT_ALLOWED',
    /** The drop's type has `variantMode = REQUIRED` and the action needs a variant. */
    VARIANTS_REQUIRED: 'PRODUCTS_VARIANTS_REQUIRED',
    /** Variant supplies exceed the drop's, or a mint exceeds the variant's. */
    VARIANT_SUPPLY_EXCEEDED: 'PRODUCTS_VARIANT_SUPPLY_EXCEEDED',
    /** The variant is archived or inactive. */
    VARIANT_INACTIVE: 'PRODUCTS_VARIANT_INACTIVE',
    /** Generation would produce more than VARIANT_GENERATE_MAX combinations. */
    VARIANT_GENERATE_TOO_LARGE: 'PRODUCTS_VARIANT_GENERATE_TOO_LARGE',
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

/**
 * Drop-type administration: dimensions, values, colors, rules. System Admin
 * only (`drop-type:manage:global`). Reading types takes `drop:read`, because
 * every drop-creation screen needs the type list.
 */
export const DROP_TYPE_MANAGE_CAPABILITY = 'drop-type:manage' as const;

export const PRODUCT_EVENTS = {
    PRODUCT_CREATED: 'products.product.created',
    PRODUCT_UPDATED: 'products.product.updated',
    PRODUCT_ARCHIVED: 'products.product.archived',
    /** A drop went live. Payload carries the target status and the review it cleared. */
    PRODUCT_PUBLISHED: 'products.product.published',
    VARIANT_CREATED: 'products.variant.created',
    VARIANT_UPDATED: 'products.variant.updated',
    VARIANT_ARCHIVED: 'products.variant.archived',
    DROP_TYPE_CREATED: 'products.drop-type.created',
    DROP_TYPE_UPDATED: 'products.drop-type.updated',
} as const;

/**
 * Most combinations one `variants/generate` call may produce, counted BEFORE
 * rules prune anything. Over it, the request is refused — never truncated, so
 * nothing is silently left out. Also the cap on an explicit `variants` list.
 */
export const VARIANT_GENERATE_MAX = 200;

/** Drop statuses in which variants may be added or removed. */
export const VARIANT_EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;

/** Audit event key for publication. Registered in the audit catalog. */
export const PRODUCT_AUDIT_EVENTS = {
    PUBLISH: 'product.publish',
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
