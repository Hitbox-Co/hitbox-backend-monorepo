/**
 * Taking ownership back.
 *
 * The design document's day-21 step: *"If claimed before return: ownership
 * revoked, tag flagged."* A refunded collectible whose claim stands would let
 * someone keep the digital certificate of an object they no longer have — and
 * then list it for resale. So a refund on a claimed unit revokes the claim and
 * quarantines the tag.
 *
 * Payments cannot do that itself: the claim, the provenance chain and the
 * SKU's trust flags belong to the claims module, and the revocation has to be
 * written into the hash chain rather than around it. So payments asks, through
 * this port, and claims decides how.
 */

export interface RevokeClaimInput {
    /** The unit to take back. */
    skuId: string;
    /** The claim being revoked, when the caller knows it. */
    claimId?: string | null;
    reason: string;
    /** User id of whoever approved the refund, or null for a system action. */
    actorId: string | null;
    /**
     * How long the unit stays off the resale market. Null leaves resale
     * untouched — used when the item came back intact and can be re-sold.
     */
    resaleBlockedUntil: Date | null;
}

export interface RevokeClaimResult {
    /** False when there was nothing to revoke (never claimed). */
    revoked: boolean;
    claimId: string | null;
    /** The ledger row that recorded the revocation, if one was written. */
    ledgerEntryId: string | null;
}

export interface IClaimRevocation {
    revokeClaim(input: RevokeClaimInput): Promise<RevokeClaimResult>;
}
