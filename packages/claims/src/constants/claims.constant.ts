export const CLAIMS_MODULE = 'claims' as const;

export const CLAIMS_ERROR_CODES = {
    /** No product carries the scanned NFC tag. */
    TAG_NOT_FOUND: 'CLAIMS_TAG_NOT_FOUND',
    /** Could not allocate a unique claim code after several attempts. */
    CLAIM_CODE_TAKEN: 'CLAIMS_CODE_TAKEN',
} as const;

/** Outcome of a tap on POST /claim/:tagId. */
export const CLAIM_OUTCOME = {
    /** The tap claimed a previously-unclaimed product for the caller. */
    CLAIMED: 'CLAIMED',
    /** The product was already claimed — we report the existing owner. */
    ALREADY_CLAIMED: 'ALREADY_CLAIMED',
} as const;

export const CLAIMS_EVENTS = {
    /** Published after a product is claimed for the first time. */
    PRODUCT_CLAIMED: 'claims.product.claimed',
} as const;

/** claimCode format: "HBPC" + 6 digits = 10 chars (fits VarChar(10)). */
export const CLAIM_CODE_PREFIX = 'HBPC';
export const CLAIM_CODE_DIGITS = 6;
export const CLAIM_CODE_MAX_ATTEMPTS = 5;

/** Origin owner recorded on the seq-0 MINT ledger row. */
export const LEDGER_ORIGIN_OWNER = 'HitBox';
