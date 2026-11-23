import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { jurisdictionFor } from '../src/domain/jurisdiction';
import { calculateInclusiveInvoice } from '../src/domain/tax-calculation';
import { TaxQuoteService } from '../src/service/tax-quote.service';

/**
 * The checkout quote and the invoice must print the same numbers. The quote
 * service is built on the invoice's own functions, so these tests pin that:
 * the same price and rate give the same split.
 */

const row = (over: Record<string, unknown> = {}) => ({
    id: 'tc-1',
    productId: null,
    countryCode: 'IN',
    stateCode: null,
    taxType: 'GST',
    taxRate: new Prisma.Decimal('12.000'),
    hsnCode: '9706',
    sacCode: null,
    effectiveFrom: new Date('2026-04-01T00:00:00Z'),
    effectiveTo: null,
    ...over,
});

function service(rows: unknown[], taxable = true) {
    const configurations = {
        findCandidates: jest.fn(async () => rows),
        hasTaxableConfiguration: jest.fn(async () => taxable),
    };
    return { quoter: new TaxQuoteService(configurations as never), configurations };
}

describe('TaxQuoteService.estimate', () => {
    it('matches the invoice arithmetic for an Indian price', async () => {
        const { quoter } = service([row()]);
        const quote = await quoter.estimate({
            productId: 'p1', countryCode: 'IN', stateCode: 'KA', currency: 'INR', unitPrice: '2499.00',
        });
        const invoice = calculateInclusiveInvoice([
            { description: 'x', quantity: 1, unitPrice: '2499.00', taxRate: '12.000' },
        ]);

        expect(quote).toMatchObject({
            countryCode: 'IN', taxType: 'GST', taxRate: '12.000',
            subtotal: invoice.subtotal, taxAmount: invoice.taxAmount, totalAmount: invoice.totalAmount,
        });
        expect(quote.totalAmount).toBe('2499.00');
    });

    it('picks the state rate over the country default, like the invoice does', async () => {
        const { quoter } = service([
            row({ id: 'us', countryCode: 'US', taxType: 'SALES_TAX', taxRate: new Prisma.Decimal('5.000'), hsnCode: null }),
            row({ id: 'ca', countryCode: 'US', stateCode: 'CA', taxType: 'SALES_TAX', taxRate: new Prisma.Decimal('8.625'), hsnCode: null }),
        ]);
        const quote = await quoter.estimate({
            productId: 'p1', countryCode: 'US', stateCode: 'CA', currency: 'USD', unitPrice: '27.16',
        });
        expect(quote).toMatchObject({ stateCode: 'CA', taxRate: '8.625', subtotal: '25.00', taxAmount: '2.16', totalAmount: '27.16' });
    });

    it('with no billing address uses the currency fallback country', async () => {
        const { quoter, configurations } = service([row()]);
        const quote = await quoter.estimate({
            productId: 'p1', countryCode: null, stateCode: null, currency: 'INR', unitPrice: '100.00',
        });
        expect(configurations.findCandidates).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'IN' }));
        expect(quote.countryCode).toBe('IN');
    });

    it('with no configured rate nothing is split out and taxType is null', async () => {
        const { quoter } = service([]);
        const quote = await quoter.estimate({
            productId: 'p1', countryCode: 'GB', stateCode: null, currency: 'GBP', unitPrice: '30.00',
        });
        expect(quote).toMatchObject({ taxType: null, taxRate: '0.000', subtotal: '30.00', taxAmount: '0.00', totalAmount: '30.00' });
    });
});

describe('TaxQuoteService.taxedByDefault', () => {
    it('asks about the fallback country of the currency', async () => {
        const { quoter, configurations } = service([], true);
        await expect(quoter.taxedByDefault({ productId: 'p1', currency: 'USD' })).resolves.toBe(true);
        expect(configurations.hasTaxableConfiguration).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'US' }));
    });
});

describe('jurisdictionFor', () => {
    it('billing country wins, upper-cased; else the currency decides', () => {
        expect(jurisdictionFor('gb', 'INR')).toBe('GB');
        expect(jurisdictionFor(null, 'INR')).toBe('IN');
        expect(jurisdictionFor(undefined, 'GBP')).toBe('US');
    });
});
