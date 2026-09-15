export const SKUS_MODULE = 'skus' as const;

export const SKUS_ERROR_CODES = {
    NOT_FOUND: 'SKUS_NOT_FOUND',
    PRODUCT_NOT_FOUND: 'SKUS_PRODUCT_NOT_FOUND',
    /** Refused: minting would push the edition past `Product.totalSupply`. */
    SUPPLY_EXCEEDED: 'SKUS_SUPPLY_EXCEEDED',
    /** Refused: an NFC tag UID is already bound to another unit. */
    TAG_TAKEN: 'SKUS_TAG_TAKEN',
    /** Refused: a concurrent mint won the serial range and retries ran out. */
    SERIAL_TAKEN: 'SKUS_SERIAL_TAKEN',
    /** Refused: the variant does not belong to the product being minted. */
    VARIANT_MISMATCH: 'SKUS_VARIANT_MISMATCH',
    FORBIDDEN: 'SKUS_FORBIDDEN',
    /** Refused: a binding names a unit that is not in this drop. */
    UNIT_NOT_IN_PRODUCT: 'SKUS_UNIT_NOT_IN_PRODUCT',
    /** Refused: the unit already carries a tag and `replace` was not set. */
    TAG_ALREADY_BOUND: 'SKUS_TAG_ALREADY_BOUND',
    /** Refused: re-tagging a claimed unit whose current tag is still healthy. */
    TAG_REPLACE_REFUSED: 'SKUS_TAG_REPLACE_REFUSED',
} as const;

/**
 * Reading serialized units.
 *
 * `manage` implies `read` in the action hierarchy, so every role holding
 * `collectible-instance:manage:*` satisfies this without listing it twice.
 *
 * Note what this capability does NOT decide: *how much* of a unit comes back.
 * That is resolved per response from the caller's own grants — see
 * domain/sku-access.ts.
 */
export const SKU_READ_CAPABILITY = 'collectible-instance:read' as const;

/**
 * Minting units and editing their trust flags.
 *
 * Deliberately NOT `globalOnly`: a Brand Admin holding
 * `collectible-instance:manage:organization` should be able to mint the
 * edition for a drop they own. The route supplies the product's organization
 * as access context, so the engine confines them to it.
 */
export const SKU_WRITE_CAPABILITY = 'collectible-instance:manage' as const;

/**
 * Binding a physical NFC tag UID to a unit.
 *
 * A separate resource from the unit itself, and that separation is the whole
 * point: tag UIDs are the platform's anti-counterfeiting secret. A HitBox Drop
 * Manager may mint 500 units of any drop (`collectible-instance:manage:global`)
 * and still may not bind a single tag, because they hold no `nfc-tag-claim`
 * grant at all.
 */
export const SKU_TAG_CAPABILITY = 'nfc-tag-claim:manage' as const;

export const SKUS_DEFAULT_LIMIT = 50;
export const SKUS_MAX_LIMIT = 200;

/**
 * Units per mint call. A 10,000-unit edition is legitimate, but it arrives as
 * ten calls rather than one transaction holding a table lock for a minute.
 */
export const SKU_MINT_MAX_BATCH = 1000;

/** Retries when a concurrent mint takes the serial range first. */
export const SKU_MINT_MAX_ATTEMPTS = 5;

/**
 * Tag bindings per bulk call.
 *
 * Matched to a vendor manifest: a box of tags ships in the hundreds, and the
 * whole batch is bound in one transaction so a half-applied manifest is not a
 * state anyone has to reconcile by hand.
 */
export const SKU_TAG_BIND_MAX = 1000;

/** `skuCode` = `<groupCode>-<serial, zero-padded to this width>`. */
export const SKU_SERIAL_PAD = 6;

export const SKU_EVENTS = {
    SKUS_MINTED: 'skus.sku.minted',
} as const;
