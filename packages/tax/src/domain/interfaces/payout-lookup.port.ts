/**
 * What this module needs to know about a royalty payout before it will file an
 * information return against it.
 *
 * This port is the technical expression of the single most consequential rule
 * in the 2026-09-15 business-logic change (compliance guide §8.3): **Form 16A
 * and 1099-NEC report royalty income that was *paid*, not royalty that
 * accrued.** So a filing cannot be built from the royalty ledger at all — it
 * must point at a payout that a HitBox admin approved and that actually
 * executed. A quarter still pending, or rejected, is excluded from the filing
 * and carries forward to the next approved cycle.
 *
 * Finance owns `RoyaltyPayout`; this port is how tax asks about one without
 * reading that table.
 */
export interface ReportablePayout {
    payoutId: string;
    payeeArtistId: string | null;
    amount: string;
    currency: string;
    /** PENDING / APPROVED / PAID / FAILED — only PAID is reportable. */
    status: string;
    /** Who approved it. Drives the separation-of-duties check. */
    approvedById: string | null;
    approvedAt: Date | null;
    paidAt: Date | null;
}

export interface IPayoutLookup {
    findById(payoutId: string): Promise<ReportablePayout | null>;

    /**
     * Every payout to one artist that was PAID within a window — the set a
     * 1099-NEC Box 1 or a Form 16A gross figure sums.
     *
     * Keyed on `paidAt`, not on the period the royalty accrued in, because
     * that is what "paid in the calendar year" means on the form.
     */
    findPaidForArtist(input: {
        artistId: string;
        from: Date;
        to: Date;
    }): Promise<ReportablePayout[]>;
}

/**
 * Which artists a user acts for.
 *
 * Needed because `payment-royalty:read:own` says "your own records" and the
 * records in this module belong to an *artist*, not to a user. The artist
 * module answers it; tax never reads the Artist table.
 */
export interface IArtistOwnership {
    findArtistIdsForUser(userId: string): Promise<string[]>;
}
