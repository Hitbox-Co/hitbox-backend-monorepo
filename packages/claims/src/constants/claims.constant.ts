export const CLAIMS_MODULE = 'claims' as const;

export const CLAIMS_ERROR_CODES = {
    /** No product carries the scanned NFC tag. */
    TAG_NOT_FOUND: 'CLAIMS_TAG_NOT_FOUND',
    /** Could not allocate a unique claim code after several attempts. */
    CLAIM_CODE_TAKEN: 'CLAIMS_CODE_TAKEN',
    /**
     * The claim token was already spent — on a claim, or on a tap that lost a
     * race, or superseded by a later validate. 409: the request was
     * well-formed and would have been valid earlier.
     */
    TOKEN_REUSED: 'CLAIMS_TOKEN_REUSED',
    /** The token passed its TTL. 410 — it existed and is now gone. */
    TOKEN_EXPIRED: 'CLAIMS_TOKEN_EXPIRED',
    /**
     * Missing, malformed, or issued to a different user or item. 400, and
     * deliberately one code for all of those: telling a caller *which* of
     * them it was tells them whether a token exists and who holds it.
     */
    TOKEN_INVALID: 'CLAIMS_TOKEN_INVALID',
} as const;

/** Outcome of a tap on POST /claims/:tagId/confirm. */
export const CLAIM_OUTCOME = {
    /** The tap claimed a previously-unclaimed product for the caller. */
    CLAIMED: 'CLAIMED',
    /** The product was already claimed — we report the existing owner. */
    ALREADY_CLAIMED: 'ALREADY_CLAIMED',
    /**
     * This tap lost a simultaneous race, by milliseconds.
     *
     * Distinct from ALREADY_CLAIMED on purpose: an item claimed weeks ago and
     * an item claimed while you were holding your phone against it are the
     * same fact and completely different experiences. The app can say "someone
     * just beat you to it" instead of "this belongs to someone else", which is
     * the difference between a race and an accusation.
     */
    CLAIMED_BY_OTHER_JUST_NOW: 'CLAIMED_BY_OTHER_JUST_NOW',
} as const;

export const CLAIMS_EVENTS = {
    /** Published after a product is claimed for the first time. */
    PRODUCT_CLAIMED: 'claims.product.claimed',
    /**
     * Published after ownership is taken back — a refund or a lost dispute.
     * Subscribers that mirror ownership (collections, search, notifications)
     * need to hear this as much as they need to hear the claim.
     */
    CLAIM_REVOKED: 'claims.claim.revoked',
    /**
     * A confirm presented a token that was not usable. The rate of these is
     * the signal: a trickle is clients retrying, a spike on one item or one
     * actor is someone replaying captured requests.
     */
    TOKEN_REJECTED: 'claims.token.rejected',
    /**
     * A confirm held a valid token but lost the tiebreak. Counting these is
     * the only way to know how often two people really do tap at once, which
     * is otherwise invisible — the loser just sees "already claimed".
     */
    TIEBREAK_LOST: 'claims.tiebreak.lost',
} as const;

/** claimCode format: "HBPC" + 6 digits = 10 chars (fits VarChar(10)). */
export const CLAIM_CODE_PREFIX = 'HBPC';
export const CLAIM_CODE_DIGITS = 6;
export const CLAIM_CODE_MAX_ATTEMPTS = 5;

/** Origin owner recorded on the seq-0 MINT ledger row. */
export const LEDGER_ORIGIN_OWNER = 'HitBox';

/**
 * `metric` values on the structured log lines this module emits, so a log
 * query does not have to match on message text.
 */
export const CLAIMS_METRICS = {
    TOKEN_REJECTED: 'claims.token.rejected',
    TIEBREAK_LOST: 'claims.tiebreak.lost',
    /** A confirm arrived with no token while the flag is off. */
    TOKEN_MISSING: 'claims.token.missing',
} as const;
