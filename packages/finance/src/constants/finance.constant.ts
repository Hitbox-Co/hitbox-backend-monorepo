export const FINANCE_MODULE = 'finance' as const;

export const FINANCE_ERROR_CODES = {
    NOT_FOUND: 'FINANCE_NOT_FOUND',
    FORBIDDEN: 'FINANCE_FORBIDDEN',
    /** No royalty rule covers the product/artist at the time of the accrual. */
    NO_RULE: 'FINANCE_NO_RULE',
    /** The order behind a claim is missing, unpaid, or already reversed. */
    NOT_ACCRUABLE: 'FINANCE_NOT_ACCRUABLE',
    /** A rule's percentage/split is not usable for a calculation. */
    INVALID_RULE: 'FINANCE_INVALID_RULE',
    /** Ledger rows are never edited — the caller tried. */
    IMMUTABLE: 'FINANCE_IMMUTABLE',
    /** An entry is not in a state the requested transition allows. */
    INVALID_TRANSITION: 'FINANCE_INVALID_TRANSITION',
    /** Nothing was eligible: below threshold, or already batched. */
    NOTHING_TO_PAY: 'FINANCE_NOTHING_TO_PAY',
    /** The entry has already been reversed — reversing twice would double-credit. */
    ALREADY_REVERSED: 'FINANCE_ALREADY_REVERSED',
} as const;

// ── Capabilities ────────────────────────────────────────────────────────────
// All four already exist in the permission catalog; finance adds none. Read is
// scope-sensitive (own / organization / global) and resolved per request from
// the grant, never from the query string.

/** Reading rules, entries, payouts, adjustments and the revenue summary. */
export const FINANCE_READ_CAPABILITY = 'payment-royalty:read' as const;
/** Writing rules, scheduling and executing payouts, posting adjustments. */
export const FINANCE_MANAGE_CAPABILITY = 'payment-royalty:manage' as const;
/** Reversing or correcting a posting outside the normal calculation. */
export const FINANCE_OVERRIDE_CAPABILITY = 'payment-royalty:override' as const;

export const FINANCE_DEFAULT_LIMIT = 20;
export const FINANCE_MAX_LIMIT = 100;

/**
 * Accrue until this much is owed, then schedule a payout.
 *
 * $500 is the figure in the design document's lifecycle example (45 orders
 * accruing $506.25). It is a *default*: `RoyaltyRule.payoutThreshold` overrides
 * it per deal, because the threshold is a term the artist negotiated, not a
 * platform constant.
 */
export const ROYALTY_DEFAULT_PAYOUT_THRESHOLD = '500.00' as const;

/** Default sweep cadence when a rule does not state one. */
export const ROYALTY_DEFAULT_PAYOUT_FREQUENCY = 'MONTHLY' as const;

/**
 * Quarantine applied to a returned unit whose tag came back damaged, missing
 * or tampered with (design document, refund scenario day 21).
 */
export const RESALE_BLOCK_DAYS = 90;

export const FINANCE_EVENTS = {
    /** A royalty was accrued against a claim. */
    ROYALTY_ACCRUED: 'finance.royalty.accrued',
    /** An accrued royalty was reversed by an adjustment. */
    ROYALTY_REVERSED: 'finance.royalty.reversed',
    /** A batch of entries crossed the threshold and was scheduled. */
    PAYOUT_SCHEDULED: 'finance.payout.scheduled',
    /** A scheduled batch was paid by the provider. */
    PAYOUT_PAID: 'finance.payout.paid',
    /** A correction was posted against a financial record. */
    ADJUSTMENT_POSTED: 'finance.adjustment.posted',
} as const;

/** Audit event types this module writes. Registered in @hitbox/audit. */
export const FINANCE_AUDIT_EVENTS = {
    ROYALTY_ACCRUE: 'royalty.accrue',
    ROYALTY_OVERRIDE: 'royalty.override',
    ROYALTY_RULE_CHANGE: 'royalty.rule.change',
    PAYOUT_SCHEDULE: 'royalty.payout.schedule',
    PAYOUT_EXECUTE: 'royalty.payout.execute',
    ADJUSTMENT_CREATE: 'adjustment.create',
} as const;

// ── COGS / royalty rate / payout approval (2026-09-15 changes) ───────────────
// Four capabilities added to the catalog by this change. Approving a payout and
// instructing its transfer are deliberately separate keys (separation of duties).

/** Entering COGS + USD/INR sales prices for a drop, and versioning them. */
export const DROP_PRICING_CAPABILITY = 'drop:configure' as const;
/** Setting an artist's royalty rate. */
export const ROYALTY_RATE_CAPABILITY = 'payment-royalty:update' as const;
/** Approving or rejecting a payout. */
export const PAYOUT_APPROVE_CAPABILITY = 'payment-royalty:approve' as const;
/** Instructing the bank transfer for an approved payout. */
export const PAYOUT_TRANSFER_CAPABILITY = 'payment-royalty:transfer' as const;

export const FINANCE_DECISION_ERROR_CODES = {
    /** A payout decision was submitted without a reason. */
    REASON_REQUIRED: 'FINANCE_REASON_REQUIRED',
    /** The artist already has a royalty rate in force for the requested window. */
    RATE_OVERLAP: 'FINANCE_RATE_OVERLAP',
    /** The drop the pricing was entered for does not exist. */
    DROP_NOT_FOUND: 'FINANCE_DROP_NOT_FOUND',
    /** The artist the rate was entered for does not exist. */
    ARTIST_NOT_FOUND: 'FINANCE_ARTIST_NOT_FOUND',
} as const;

export const FINANCE_DECISION_EVENTS = {
    PAYOUT_APPROVED: 'finance.payout.approved',
    PAYOUT_REJECTED: 'finance.payout.rejected',
    DROP_PRICING_CREATED: 'finance.drop-pricing.created',
    ARTIST_ROYALTY_RATE_SET: 'finance.artist-royalty-rate.set',
} as const;

export const FINANCE_DECISION_AUDIT_EVENTS = {
    PAYOUT_APPROVE: 'royalty.payout.approve',
    PAYOUT_REJECT: 'royalty.payout.reject',
    PAYOUT_TRANSFER: 'royalty.payout.transfer',
    /** Reuses the registered `royalty.payout.schedule` type. */
    PAYOUT_QUARTERLY_SWEEP: 'royalty.payout.schedule',
    DROP_PRICING_CREATE: 'drop.pricing.create',
    /** Reuses the registered `royalty.rule.change` type. */
    ARTIST_RATE_SET: 'royalty.rule.change',
} as const;

/** Quarter boundaries: Jan 1, Apr 1, Jul 1, Oct 1, 00:00 UTC. */
export const QUARTER_START_MONTHS = [0, 3, 6, 9] as const;
