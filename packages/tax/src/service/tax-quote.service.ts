import { jurisdictionFor } from '../domain/jurisdiction';
import { calculateInclusiveInvoice, resolveTaxConfiguration } from '../domain/tax-calculation';
import type { TaxConfigurationRepository } from '../repository/tax-configuration.repository';

export interface TaxEstimateInput {
    productId: string;
    /** Billing country; null → the currency's fallback country. */
    countryCode: string | null;
    stateCode: string | null;
    currency: string;
    /** The sticker price of one unit: tax is already inside it. */
    unitPrice: string;
    quantity?: number;
    at?: Date;
}

export interface TaxEstimate {
    countryCode: string;
    stateCode: string | null;
    /** Null when no rate is configured for the jurisdiction. */
    taxType: 'GST' | 'SALES_TAX' | 'EXEMPT' | null;
    taxRate: string;
    /** The price without tax. */
    subtotal: string;
    /** The part of the price that is tax. */
    taxAmount: string;
    /** subtotal + taxAmount: always equal to the price (× quantity). */
    totalAmount: string;
}

/**
 * What an order's tax will be, worked out *before* the order exists.
 *
 * This is the invoice's own arithmetic, not a copy of it: it resolves the rate
 * with `resolveTaxConfiguration` and splits the price with
 * `calculateInclusiveInvoice`, the two functions `InvoiceService` issues with.
 * Same inputs, same answer, which is the point of a quote.
 *
 * Standalone on purpose (repository only): payments needs it to build checkout
 * before the tax module is constructed, and the tax module subscribes to
 * payments' events, so a dependency on the whole module would be circular.
 */
export class TaxQuoteService {
    constructor(private readonly configurations: TaxConfigurationRepository) { }

    async estimate(input: TaxEstimateInput): Promise<TaxEstimate> {
        const at = input.at ?? new Date();
        const countryCode = jurisdictionFor(input.countryCode, input.currency);
        const stateCode = input.stateCode ? input.stateCode.toUpperCase() : null;
        const quantity = input.quantity ?? 1;

        const rows = await this.configurations.findCandidates({
            productId: input.productId,
            countryCode,
            stateCode,
        });
        const configuration = resolveTaxConfiguration(
            rows.map((row) => ({
                id: row.id,
                productId: row.productId,
                countryCode: row.countryCode,
                stateCode: row.stateCode,
                taxType: row.taxType,
                taxRate: row.taxRate.toString(),
                hsnCode: row.hsnCode,
                sacCode: row.sacCode,
                effectiveFrom: row.effectiveFrom,
                effectiveTo: row.effectiveTo,
            })),
            { productId: input.productId, countryCode, stateCode, at },
        );

        // No rate configured: nothing is split out, and the invoice would refuse
        // to issue (NO_TAX_CONFIGURATION) — a setup gap staff must close, not
        // something to price around here.
        const totals = calculateInclusiveInvoice([
            {
                description: 'quote',
                quantity,
                unitPrice: input.unitPrice,
                taxRate: configuration?.taxRate ?? '0',
            },
        ]);

        return {
            countryCode,
            stateCode,
            taxType: (configuration?.taxType as TaxEstimate['taxType']) ?? null,
            taxRate: totals.uniformTaxRate ?? '0.000',
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
        };
    }

    /**
     * Whether this sale is taxed *if the buyer's country is the currency's
     * fallback*. Decides whether checkout must insist on a billing address.
     */
    taxedByDefault(input: { productId: string; currency: string; at?: Date }): Promise<boolean> {
        return this.configurations.hasTaxableConfiguration({
            productId: input.productId,
            countryCode: jurisdictionFor(null, input.currency),
            at: input.at ?? new Date(),
        });
    }
}

/** Builds the quoter from a Prisma client, with no other module wiring. */
export function createTaxQuoter(deps: {
    configurations: TaxConfigurationRepository;
}): TaxQuoteService {
    return new TaxQuoteService(deps.configurations);
}
