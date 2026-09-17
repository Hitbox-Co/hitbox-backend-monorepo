/**
 * HitBox's own identity as a supplier, per jurisdiction — the "FROM" block of
 * the invoice and the registration numbers a tax authority matches against.
 *
 * Configuration rather than a database table, and injected at bootstrap rather
 * than read from env in here, for three reasons:
 *
 *   1. It is deployment identity, not business data. A staging deploy must not
 *      print a production GSTIN, and a single environment variable is the
 *      cheapest way to guarantee that.
 *   2. There is exactly one row per country and it changes roughly never. A
 *      table would be a one-row table with an admin screen nobody opens.
 *   3. Every field is copied onto each invoice at issue anyway (see the
 *      `supplier*` columns on `Invoice`), so the configuration is only ever
 *      read at the moment of issue — history does not depend on it.
 *
 * A jurisdiction with no profile configured cannot issue invoices in it: the
 * service raises `SUPPLIER_NOT_CONFIGURED` rather than printing a document with
 * a blank GSTIN, which under Indian GST law is not an invoice at all.
 */
export interface SupplierProfile {
    countryCode: string;
    legalName: string;
    /** Printed as-is, one array element per line. */
    addressLines: string[];
    /** India: GSTIN. Mandatory for an Indian invoice. */
    gstin?: string | undefined;
    /** India: PAN, when it differs from the GSTIN's embedded PAN. */
    pan?: string | undefined;
    /** US: EIN. */
    ein?: string | undefined;
    email?: string | undefined;
    phone?: string | undefined;
    /** Printed under "Payment". Never account numbers — see below. */
    paymentInstructions?: string[] | undefined;
}

/**
 * Whether this profile can legally issue an invoice in its jurisdiction.
 *
 * India is the strict case: §1.4 of the compliance guide lists the supplier's
 * GSTIN as a mandatory field, and an invoice missing one is not a tax invoice.
 * The US has no federal invoice law at all, so an EIN is best practice rather
 * than a requirement and its absence does not block issue.
 */
export function supplierIsIssuable(profile: SupplierProfile): boolean {
    if (profile.countryCode === 'IN') return Boolean(profile.gstin);
    return true;
}

/** Flattens the address for the `supplierAddress` snapshot column. */
export function formatSupplierAddress(profile: SupplierProfile): string {
    return profile.addressLines.join('\n');
}

/**
 * Builds the profile map from environment variables.
 *
 * Bank account numbers are deliberately absent. The compliance guide's example
 * invoice prints "Bank: ICICI Bank / Account: [HitBox Account]" — a placeholder
 * in the guide, and it stays a placeholder here. Printing a full account number
 * on every customer-facing PDF, stored in an object store and e-mailed out, is
 * a fraud surface for no benefit: HitBox is paid through the payment gateway
 * before the invoice exists, so the document is a receipt, not a request for
 * payment. `paymentInstructions` carries the method that was actually used.
 */
export function supplierProfilesFromEnv(source: Record<string, string | undefined>): Map<string, SupplierProfile> {
    const profiles = new Map<string, SupplierProfile>();

    if (source.TAX_SUPPLIER_IN_GSTIN) {
        profiles.set('IN', {
            countryCode: 'IN',
            legalName: source.TAX_SUPPLIER_IN_NAME ?? 'HitBox Collectibles Private Limited',
            addressLines: splitLines(source.TAX_SUPPLIER_IN_ADDRESS),
            gstin: source.TAX_SUPPLIER_IN_GSTIN,
            pan: source.TAX_SUPPLIER_IN_PAN,
            email: source.TAX_SUPPLIER_EMAIL,
            phone: source.TAX_SUPPLIER_IN_PHONE,
        });
    }

    if (source.TAX_SUPPLIER_US_EIN || source.TAX_SUPPLIER_US_ADDRESS) {
        profiles.set('US', {
            countryCode: 'US',
            legalName: source.TAX_SUPPLIER_US_NAME ?? 'HitBox Collectibles Inc.',
            addressLines: splitLines(source.TAX_SUPPLIER_US_ADDRESS),
            ein: source.TAX_SUPPLIER_US_EIN,
            email: source.TAX_SUPPLIER_EMAIL,
            phone: source.TAX_SUPPLIER_US_PHONE,
        });
    }

    return profiles;
}

/** `"a | b | c"` -> three lines. Pipe-separated so one env var holds an address. */
function splitLines(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split('|')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
