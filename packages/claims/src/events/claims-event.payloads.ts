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
