import { addMoney, multiplyMoney, rate, sumMoney, taxOn } from './money';

/**
 * The arithmetic of an invoice, as a pure function of its inputs.
 *
 * Separated from the service because this is the part an auditor re-checks and
 * a test pins to the figures in the compliance guide: ₹2,000 at 12% GST is
 * ₹240 and ₹2,240 total (§1.1); $25.00 at 8.625% sales tax is $2.16 and $27.16
 * total (§2.1). Nothing here touches the database, the clock or the request.
 *
 * Tax is computed **per line and then summed**, not on the invoice subtotal.
 * With one rate and one line the two are identical, which is every invoice
 * HitBox issues today — but they diverge the moment an invoice carries a 12%
 * collectible and an 18% premium item, and a return is filed on the line-level
 * figures. Getting the order of operations right now costs nothing; changing it
 * later would mean re-deriving already-filed numbers.
 */

export interface TaxLineInput {
    description: string;
    productId?: string | null;
    skuId?: string | null;
    hsnCode?: string | null;
    sacCode?: string | null;
    quantity: number;
    /** Exclusive of tax. */
    unitPrice: string;
    /** Percentage, e.g. '12.00'. */
    taxRate: string;
}

export interface TaxLine extends TaxLineInput {
    position: number;
    lineSubtotal: string;
    taxAmount: string;
    lineTotal: string;
}

export interface InvoiceTotals {
    lines: TaxLine[];
    subtotal: string;
    taxAmount: string;
    totalAmount: string;
    /**
     * The single rate the invoice was issued at, when every line shares one —
     * which is what goes in `Invoice.taxRate`. Null when lines differ, and the
     * caller must then read the per-line rates.
     */
    uniformTaxRate: string | null;
    /** Likewise for the HSN code denormalised onto the invoice header. */
    uniformHsnCode: string | null;
}

export function calculateInvoice(inputs: TaxLineInput[]): InvoiceTotals {
    if (inputs.length === 0) {
        throw new Error('An invoice must have at least one line item.');
    }

    const lines = inputs.map((input, index): TaxLine => {
        if (!Number.isInteger(input.quantity) || input.quantity < 1) {
            throw new Error(
                `Line ${index + 1} has a non-positive quantity (${input.quantity}).`,
            );
        }
        const lineSubtotal = multiplyMoney(input.unitPrice, input.quantity);
        const taxAmount = taxOn(lineSubtotal, input.taxRate);
        return {
            ...input,
            taxRate: rate(input.taxRate),
            position: index + 1,
            lineSubtotal,
            taxAmount,
            lineTotal: addMoney(lineSubtotal, taxAmount),
        };
    });

    const subtotal = sumMoney(lines.map((line) => line.lineSubtotal));
    const taxAmount = sumMoney(lines.map((line) => line.taxAmount));

    const rates = new Set(lines.map((line) => line.taxRate));
    const hsnCodes = new Set(lines.map((line) => line.hsnCode ?? ''));

    return {
        lines,
        subtotal,
        taxAmount,
        totalAmount: addMoney(subtotal, taxAmount),
        uniformTaxRate: rates.size === 1 ? (lines[0] as TaxLine).taxRate : null,
        uniformHsnCode:
            hsnCodes.size === 1 && (lines[0] as TaxLine).hsnCode
                ? ((lines[0] as TaxLine).hsnCode as string)
                : null,
    };
}

/**
 * Picks the TaxConfiguration row that applies, most-specific-first.
 *
 * Resolution order — product+state, product+country, state default, country
 * default — mirrors how `RoyaltyRule` resolves, and for the same reason: the
 * specific case is the exception and the general case must still produce an
 * answer. A product with no row of its own falls back to the jurisdiction's
 * default rate rather than failing, because "no configuration" for a *product*
 * is normal, while no configuration for a *country* is a setup error and does
 * fail loudly (the service raises NO_TAX_CONFIGURATION).
 *
 * `at` filters the effective window, so re-deriving an old invoice picks the
 * rate that was in force on its date, not today's.
 */
export interface ResolvableTaxConfiguration {
    id: string;
    productId: string | null;
    countryCode: string;
    stateCode: string | null;
    taxType: string;
    taxRate: string;
    hsnCode: string | null;
    sacCode: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
}

export function resolveTaxConfiguration(
    candidates: ResolvableTaxConfiguration[],
    target: { productId: string; countryCode: string; stateCode: string | null; at: Date },
): ResolvableTaxConfiguration | null {
    const inForce = candidates.filter(
        (candidate) =>
            candidate.countryCode === target.countryCode &&
            candidate.effectiveFrom <= target.at &&
            (candidate.effectiveTo === null || candidate.effectiveTo > target.at),
    );

    const specificity = (candidate: ResolvableTaxConfiguration): number => {
        const productMatch = candidate.productId === target.productId;
        const stateMatch =
            target.stateCode !== null && candidate.stateCode === target.stateCode;
        if (productMatch && stateMatch) return 4;
        if (productMatch && candidate.stateCode === null) return 3;
        if (candidate.productId === null && stateMatch) return 2;
        if (candidate.productId === null && candidate.stateCode === null) return 1;
        // A row for another product, or another state — not applicable at all.
        return 0;
    };

    let best: { candidate: ResolvableTaxConfiguration; rank: number } | null = null;
    for (const candidate of inForce) {
        const rank = specificity(candidate);
        if (rank === 0) continue;
        // Ties break on the later effectiveFrom: two rows at the same
        // specificity means one superseded the other.
        if (
            !best ||
            rank > best.rank ||
            (rank === best.rank && candidate.effectiveFrom > best.candidate.effectiveFrom)
        ) {
            best = { candidate, rank };
        }
    }
    return best?.candidate ?? null;
}
