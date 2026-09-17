export const TAX_MODULE = 'tax' as const;

export const TAX_ERROR_CODES = {
    NOT_FOUND: 'TAX_NOT_FOUND',
    FORBIDDEN: 'TAX_FORBIDDEN',
    /** No TaxConfiguration covers the product/jurisdiction at the invoice date. */
    NO_TAX_CONFIGURATION: 'TAX_NO_CONFIGURATION',
    /** The order is not in a state an invoice may be issued against. */
    ORDER_NOT_INVOICEABLE: 'TAX_ORDER_NOT_INVOICEABLE',
    /** An invoice already exists for this order. */
    INVOICE_EXISTS: 'TAX_INVOICE_EXISTS',
    /** Issued invoices are never edited — the caller tried. */
    IMMUTABLE: 'TAX_IMMUTABLE',
    /** The record is not in a state the requested transition allows. */
    INVALID_TRANSITION: 'TAX_INVALID_TRANSITION',
    /** Supplier identity (GSTIN / EIN) is not configured for this jurisdiction. */
    SUPPLIER_NOT_CONFIGURED: 'TAX_SUPPLIER_NOT_CONFIGURED',
    /** Document storage is not configured on this deployment. */
    STORAGE_UNAVAILABLE: 'TAX_STORAGE_UNAVAILABLE',
    /** The PDF has not been rendered yet, so there is nothing to serve. */
    DOCUMENT_NOT_RENDERED: 'TAX_DOCUMENT_NOT_RENDERED',
    /** A Form 16A / 1099-NEC was requested against a payout that is not paid. */
    PAYOUT_NOT_REPORTABLE: 'TAX_PAYOUT_NOT_REPORTABLE',
    /** Separation of duties: the approver of a payout may not file against it. */
    SEPARATION_OF_DUTIES: 'TAX_SEPARATION_OF_DUTIES',
} as const;

// ── Capabilities ────────────────────────────────────────────────────────────
// This module adds NO new permissions. Every capability below already exists in
// the access-control catalog, for the same reason finance adds none: a tax
// invoice is a payment record, an artist's W-9 is a document, and a GSTR-1
// export is a report. Inventing `tax:*` would mean a new ResourceType enum
// value, a migration, and a second place where "who may see money" is decided.
//
// The scope of the grant (own / organization / global) is what separates a
// buyer fetching their own invoice from a finance operator listing every
// invoice in a quarter. It is resolved from the grant, never from the query.

/** Reading invoices, tax configuration, filings and artist tax documents. */
export const TAX_READ_CAPABILITY = 'payment-royalty:read' as const;
/** Writing tax configuration, issuing/voiding invoices, creating filings. */
export const TAX_MANAGE_CAPABILITY = 'payment-royalty:manage' as const;
/** Approving a correction to an already-issued statutory figure. */
export const TAX_OVERRIDE_CAPABILITY = 'payment-royalty:override' as const;
/** A buyer reaching their own order's invoice. */
export const TAX_ORDER_READ_CAPABILITY = 'order:read' as const;
/** Exporting a return dataset (GSTR-1, state sales tax, 1099 summary). */
export const TAX_EXPORT_CAPABILITY = 'reports-dashboards:export' as const;

export const TAX_DEFAULT_LIMIT = 20;
export const TAX_MAX_LIMIT = 100;

// ── Statutory defaults ──────────────────────────────────────────────────────
// Rates live in TaxConfiguration, not here. These are the fallbacks the seeder
// writes and the figures the compliance guide states, kept in one place so the
// seed, the tests and the documentation cannot drift apart.

/**
 * HSN 9706 — "antiques and art; sports memorabilia". The single code every
 * physical HitBox collectible is classified under, at 12% GST.
 *
 * Compliance guide §1.3: the code is matched by the GST department against
 * GSTR-1 and GSTR-3B filings, and a mismatch triggers an audit notice. It is
 * therefore mandatory on every Indian invoice line, which is why the renderer
 * refuses to produce an Indian invoice without one.
 */
export const HSN_COLLECTIBLES = '9706' as const;
/** SAC 998361 — online marketplace services, 18%. Commission invoices. */
export const SAC_MARKETPLACE_SERVICE = '998361' as const;
/** SAC 998999 — digital goods / information services. */
export const SAC_DIGITAL_CONTENT = '998999' as const;

export const GST_RATE_COLLECTIBLES = '12.00' as const;
export const GST_RATE_PREMIUM = '18.00' as const;
export const GST_RATE_MARKETPLACE_SERVICE = '18.00' as const;

/** India TDS on artist royalties, s.194O. Applied by finance, reported here. */
export const TDS_RATE_ROYALTY = '30.00' as const;
/** US backup withholding when no valid W-9 is on file (IRS). */
export const US_BACKUP_WITHHOLDING_RATE = '24.00' as const;
/** 1099-NEC is only issued above this much paid in a calendar year. */
export const FORM_1099_NEC_THRESHOLD_USD = '600.00' as const;

/** Payment terms printed on the invoice. */
export const INVOICE_PAYMENT_TERMS_DAYS = 7;

export const TAX_EVENTS = {
    /** An invoice was issued for a settled order. */
    INVOICE_ISSUED: 'tax.invoice.issued',
    /** The invoice PDF was rendered and stored. */
    INVOICE_DOCUMENT_STORED: 'tax.invoice.document.stored',
    /** An invoice was cancelled. */
    INVOICE_VOIDED: 'tax.invoice.voided',
    /** A tax correction was approved against an invoice. */
    ADJUSTMENT_APPROVED: 'tax.adjustment.approved',
    /** A return or certificate was marked filed. */
    FILING_FILED: 'tax.filing.filed',
    /** An artist tax document was verified or rejected. */
    ARTIST_DOCUMENT_REVIEWED: 'tax.artist-document.reviewed',
} as const;

/** Audit event types this module writes. Registered in @hitbox/audit. */
export const TAX_AUDIT_EVENTS = {
    INVOICE_ISSUE: 'tax.invoice.issue',
    INVOICE_VOID: 'tax.invoice.void',
    INVOICE_DOWNLOAD: 'tax.invoice.download',
    TAX_CONFIG_CHANGE: 'tax.configuration.change',
    ADJUSTMENT_APPROVE: 'tax.adjustment.approve',
    FILING_CREATE: 'tax.filing.create',
    FILING_FILE: 'tax.filing.file',
    ARTIST_DOCUMENT_REVIEW: 'tax.artist-document.review',
    ARTIST_DOCUMENT_DOWNLOAD: 'tax.artist-document.download',
} as const;
