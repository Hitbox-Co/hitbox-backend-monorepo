/**
 * Event payload contracts published by the claims module. Other modules
 * (collections, analytics, notifications…) subscribe to these — this file is
 * the shared contract, so keep it stable.
 */

/**
 * Emitted by CLAIMS_EVENTS.PRODUCT_CLAIMED after a successful first claim.
 *
 * `skuId` identifies the serialized item that was claimed; `productId` is the
 * catalog entry behind it, kept so subscribers that only care about the drop
 * do not need a second lookup.
 */
export interface ProductClaimedPayload {
    claimId: string;
    skuId: string;
    productId: string;
    userId: string;
}

/**
 * Emitted by CLAIMS_EVENTS.CLAIM_REVOKED after ownership is taken back, which
 * today means a refund was executed or a dispute was lost.
 *
 * `claimId` is null when the unit turned out to hold no live claim.
 * `resaleBlockedUntil` is set when the returned tag was damaged, missing or
 * tampered with and the unit is quarantined until that moment.
 */
export interface ClaimRevokedPayload {
    skuId: string;
    claimId: string | null;
    reason: string;
    actorId: string | null;
    resaleBlockedUntil: string | null;
}

/**
 * Emitted by CLAIMS_EVENTS.TOKEN_REJECTED when a confirm presented a token
 * that was not usable.
 *
 * Published for the rate, not the individual event: a trickle is clients
 * retrying a request that already succeeded, while a spike against one item —
 * or from one actor across many items — is someone replaying captured
 * requests. That distinction is only visible in aggregate, which is why this
 * is an event and not just a 409.
 *
 * `tokenId` is null when the token was never issued by us at all, which is
 * itself the most interesting case.
 */
export interface ClaimTokenRejectedPayload {
    skuId: string;
    userId: string;
    reason: 'INVALID' | 'REUSED' | 'EXPIRED';
    tokenId: string | null;
    /** ISO 8601. */
    at: string;
}

/**
 * Emitted by CLAIMS_EVENTS.TIEBREAK_LOST when a confirm held a valid token
 * but another request claimed the item first.
 *
 * Counting these is the only way to know how often two people genuinely tap
 * the same item at once. Without it the loser's experience is indistinguish-
 * able from tapping something claimed last month, and the rate is invisible.
 */
export interface ClaimTiebreakLostPayload {
    skuId: string;
    loserUserId: string;
    /** Null only if the winner's row could not be re-read. */
    winnerUserId: string | null;
    tokenId: string | null;
    /** ISO 8601. */
    at: string;
}
