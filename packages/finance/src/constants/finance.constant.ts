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
