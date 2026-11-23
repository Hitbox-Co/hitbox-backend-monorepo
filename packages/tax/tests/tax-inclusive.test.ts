import { describe, expect, it } from '@jest/globals';
import { addMoney, netOfTax, subtractMoney } from '../src/domain/money';
import { calculateInclusiveInvoice, calculateInvoice } from '../src/domain/tax-calculation';

/**
 * Prices include tax. The invoice total is the amount charged, and the tax is
 * the part of it that belongs to the tax authority.
 */

describe('netOfTax: the tax-inclusive split', () => {
    it('Rs 2,240 at 12% GST is Rs 2,000 net', () => {
        expect(netOfTax('2240.00', '12')).toBe('2000.00');
    });

    it('Rs 2,499 at 12% GST splits so net + tax is exactly the price', () => {
        const net = netOfTax('2499.00', '12');
        expect(net).toBe('2231.25');
        expect(addMoney(net, subtractMoney('2499.00', net))).toBe('2499.00');
    });

    it('$27.16 at 8.625% sales tax is $25.00 net', () => {
        expect(netOfTax('27.16', '8.625')).toBe('25.00');
    });

    it('a zero rate leaves the price alone', () => {
        expect(netOfTax('10.00', '0')).toBe('10.00');
    });
});

describe('calculateInclusiveInvoice', () => {
    it('the invoice total is the price charged, and tax is the part of it', () => {
        const totals = calculateInclusiveInvoice([
            { description: 'Tee', hsnCode: '9706', quantity: 1, unitPrice: '2499.00', taxRate: '12' },
        ]);

        expect(totals.totalAmount).toBe('2499.00');
        expect(totals.subtotal).toBe('2231.25');
        expect(totals.taxAmount).toBe('267.75');
        expect(totals.uniformTaxRate).toBe('12.000');
        expect(totals.lines[0]).toMatchObject({
            unitPrice: '2231.25',
            lineSubtotal: '2231.25',
            taxAmount: '267.75',
            lineTotal: '2499.00',
        });
    });

    it('never disagrees with the charge, whatever the price or rate', () => {
        for (const price of ['0.99', '10.00', '33.33', '1999.99', '24999.00']) {
            for (const taxRate of ['0', '5', '12', '18', '8.625', '8.875']) {
                const totals = calculateInclusiveInvoice([
                    { description: 'x', quantity: 1, unitPrice: price, taxRate },
                ]);
                expect(totals.totalAmount).toBe(price);
                expect(addMoney(totals.subtotal, totals.taxAmount)).toBe(price);
            }
        }
    });

    it('rejects an empty invoice and a bad quantity', () => {
        expect(() => calculateInclusiveInvoice([])).toThrow();
        expect(() =>
            calculateInclusiveInvoice([{ description: 'x', quantity: 0, unitPrice: '1.00', taxRate: '5' }]),
        ).toThrow();
    });

    it('leaves the exclusive calculation untouched', () => {
        const totals = calculateInvoice([
            { description: 'Jersey', quantity: 1, unitPrice: '2000.00', taxRate: '12' },
        ]);
        expect(totals.totalAmount).toBe('2240.00');
    });
});
