/**
 * Event payload contracts published by the claims module. Other modules
 * (collections, analytics, notifications…) subscribe to these — this file is
 * the shared contract, so keep it stable.
 */

/** Emitted by CLAIMS_EVENTS.PRODUCT_CLAIMED after a successful first claim. */
export interface ProductClaimedPayload {
    claimId: string;
    productId: string;
    userId: string;
}
