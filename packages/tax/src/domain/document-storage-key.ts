/**
 * The S3 key convention for tax documents.
 *
 *   s3://hitbox-media-{env}/
 *     tax-invoices/{country}/{fiscalYear}/{invoiceNumber}.pdf
 *     tax-filings/{country}/{filingType}/{period}/{filingId}.pdf
 *     tax-artist-documents/artists/{artistId}/{documentType}/{documentId}.{ext}
 *
 * Three separate top-level prefixes rather than one `tax/`, for the same
 * folder-first-by-type reason `@hitbox/media` gives: the three differ in
 * exactly the ways a prefix expresses.
 *
 *   **Retention.** Invoices and filings are kept 8 years (India's GST record
 *   requirement is 72 months from the annual return due date; the IRS asks for
 *   at least 4 years for employment-tax records and 7 is the common practice).
 *   Artist tax documents are kept for as long as the relationship plus 7 years.
 *   Those are three different lifecycle rules and a lifecycle rule is written
 *   against a prefix.
 *
 *   **IAM.** A finance operator's export tooling can be granted
 *   `tax-invoices/*` and `tax-filings/*` without ever being able to read a
 *   W-9 — `tax-artist-documents/*` holds the single most sensitive class of
 *   file on the platform (an SSN sits on a W-9) and is scoped separately.
 *
 *   **Public-read.** None of these prefixes are in `PUBLIC_PREFIXES`, and none
 *   may ever be. Every object here is private at the bucket and reachable only
 *   through a short-lived presigned GET issued after a permission check. An
 *   invoice carries a customer's name and address; a W-9 carries a taxpayer
 *   identification number. This is asserted by a test rather than left to
 *   review, because the failure mode is silent and permanent.
 *
 * The filename is the invoice number / filing id / document id, never anything
 * user-supplied: the key is derivable from the database row alone, collisions
 * are impossible, and there is no user string in a path to traverse with.
 */

export const TAX_INVOICE_PREFIX = 'tax-invoices/' as const;
export const TAX_FILING_PREFIX = 'tax-filings/' as const;
export const TAX_ARTIST_DOCUMENT_PREFIX = 'tax-artist-documents/' as const;

/** Every prefix this module writes to. All private; see the note above. */
export const TAX_PREFIXES = [
    TAX_INVOICE_PREFIX,
    TAX_FILING_PREFIX,
    TAX_ARTIST_DOCUMENT_PREFIX,
] as const;

/** Is this key one of ours? Used by the storage adapter as a sanity guard. */
export function isTaxKey(key: string): boolean {
    return TAX_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Rejects anything that could escape the prefix or address another object. */
function segment(value: string, what: string): string {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
        throw new Error(`Unsafe ${what} for a storage key: "${value}"`);
    }
    return value;
}

export function invoiceDocumentKey(input: {
    countryCode: string;
    fiscalYear: string;
    invoiceNumber: string;
}): string {
    return (
        `${TAX_INVOICE_PREFIX}` +
        `${segment(input.countryCode, 'country code')}/` +
        `${segment(input.fiscalYear, 'fiscal year')}/` +
        `${segment(input.invoiceNumber, 'invoice number')}.pdf`
    );
}

export function filingDocumentKey(input: {
    countryCode: string;
    filingType: string;
    period: string;
    filingId: string;
}): string {
    return (
        `${TAX_FILING_PREFIX}` +
        `${segment(input.countryCode, 'country code')}/` +
        `${segment(input.filingType, 'filing type')}/` +
        `${segment(input.period, 'period')}/` +
        `${segment(input.filingId, 'filing id')}.pdf`
    );
}

export function artistTaxDocumentKey(input: {
    artistId: string;
    documentType: string;
    documentId: string;
    extension: string;
}): string {
    return (
        `${TAX_ARTIST_DOCUMENT_PREFIX}artists/` +
        `${segment(input.artistId, 'artist id')}/` +
        `${segment(input.documentType, 'document type')}/` +
        `${segment(input.documentId, 'document id')}.` +
        `${segment(normaliseExtension(input.extension), 'extension')}`
    );
}

/** `Scan.PDF` -> `pdf`. Extension only, lowercased, alphanumerics only. */
export function normaliseExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    const raw = (dot === -1 ? fileName : fileName.slice(dot + 1)).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'bin';
}
