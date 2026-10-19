/**
 * The invoice number format.
 *
 *     INV-2026-27-IN-000123
 *     └┬┘ └──┬──┘ └┬┘ └──┬─┘
 *      │     │     │     └── sequence within the series, zero-padded to 6
 *      │     │     └──────── jurisdiction — each country numbers independently
 *      │     └────────────── fiscal year the series belongs to
 *      └──────────────────── fixed prefix
 *
 * Indian GST law requires an invoice number that is unique, sequential and
 * gap-free within a financial year, at most 16 characters, and restricted to
 * alphanumerics plus `-` and `/`. This format is 21 characters, which is over
 * that limit — a deliberate trade recorded here rather than discovered later:
 *
 *   The 16-character rule applies to the number as filed on a GST return. When
 *   HitBox's Indian GST registration is live and GSTR-1 filing is wired up
 *   (roadmap Phase 3), the Indian series must be shortened — dropping the
 *   country segment and the `20` of the year gives `INV-2627-000123` at 15
 *   characters, which fits. Until an invoice is actually filed on a return,
 *   the readable form is worth more than the constraint, and the sequence
 *   itself — the part that has to be gap-free — is unaffected by the change.
 *
 * `US` numbers have no statutory format at all (there is no federal invoice
 * law), so they use the same shape for consistency.
 */

const PREFIX = 'INV';
const SEQUENCE_DIGITS = 6;

export interface InvoiceNumberParts {
    fiscalYear: string;
    countryCode: string;
    sequence: number;
}

export function formatInvoiceNumber(parts: InvoiceNumberParts): string {
    if (parts.sequence < 1) {
        throw new Error(`Invoice sequence must be positive, got ${parts.sequence}`);
    }
    const sequence = String(parts.sequence).padStart(SEQUENCE_DIGITS, '0');
    return `${PREFIX}-${parts.fiscalYear}-${parts.countryCode}-${sequence}`;
}

/** Inverse of `formatInvoiceNumber`. Returns null for anything else. */
export function parseInvoiceNumber(value: string): InvoiceNumberParts | null {
    const match = /^INV-(\d{4}(?:-\d{2})?)-([A-Z]{2})-(\d{6,})$/.exec(value);
    if (!match) return null;
    return {
        fiscalYear: match[1] as string,
        countryCode: match[2] as string,
        sequence: Number(match[3]),
    };
}

/**
 * The Indian-GST-compliant short form of a number, for the day GSTR-1 filing
 * goes live. Kept beside the format it derives from so the two cannot drift.
 *
 *     INV-2026-27-IN-000123  ->  INV-2627-000123   (15 chars)
 */
export function toGstFilingFormat(invoiceNumber: string): string {
    const parts = parseInvoiceNumber(invoiceNumber);
    if (!parts) return invoiceNumber;
    const [start, end] = parts.fiscalYear.split('-');
    const year = end ? `${(start as string).slice(2)}${end}` : (start as string).slice(2);
    return `${PREFIX}-${year}-${String(parts.sequence).padStart(SEQUENCE_DIGITS, '0')}`;
}
