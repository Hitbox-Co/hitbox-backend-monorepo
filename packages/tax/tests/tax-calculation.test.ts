import { describe, expect, it } from '@jest/globals';
import { calculateInvoice, resolveTaxConfiguration } from '../src/domain/tax-calculation';
import type { ResolvableTaxConfiguration } from '../src/domain/tax-calculation';

describe('calculateInvoice', () => {
    it('reproduces the Indian example from §1.4 of the compliance guide', () => {
        const totals = calculateInvoice([
            {
                description: 'LeBron James Jersey',
                hsnCode: '9706',
                quantity: 1,
                unitPrice: '2000.00',
                taxRate: '12',
            },
        ]);

        expect(totals.subtotal).toBe('2000.00');
        expect(totals.taxAmount).toBe('240.00');
        expect(totals.totalAmount).toBe('2240.00');
        expect(totals.uniformTaxRate).toBe('12.000');
        expect(totals.uniformHsnCode).toBe('9706');
    });

    it('reproduces the US example from §2.3', () => {
        const totals = calculateInvoice([
            {
                description: 'Signed LeBron Jersey',
                quantity: 1,
                unitPrice: '25.00',
                taxRate: '8.625',
            },
        ]);

        expect(totals.subtotal).toBe('25.00');
        expect(totals.taxAmount).toBe('2.16');
        expect(totals.totalAmount).toBe('27.16');
        expect(totals.uniformTaxRate).toBe('8.625');
        // No HSN in the US — the header code must stay null rather than
        // inventing one.
        expect(totals.uniformHsnCode).toBeNull();
    });

    it('taxes each line and sums, rather than taxing the subtotal', () => {
        // Two lines at different rates. Taxing the £-subtotal at one rate
        // would be wrong; this is the case where the two orders of operation
        // give different answers.
        const totals = calculateInvoice([
            { description: 'Card', hsnCode: '9706', quantity: 1, unitPrice: '100.00', taxRate: '12' },
            { description: 'Signed bat', hsnCode: '9706', quantity: 1, unitPrice: '100.00', taxRate: '18' },
        ]);

        expect(totals.subtotal).toBe('200.00');
        expect(totals.taxAmount).toBe('30.00'); // 12 + 18
        expect(totals.totalAmount).toBe('230.00');
        // Mixed rates: the header rate cannot be a single number.
        expect(totals.uniformTaxRate).toBeNull();
    });

    it('multiplies by quantity before taxing', () => {
        const totals = calculateInvoice([
            { description: 'Card', quantity: 3, unitPrice: '19.99', taxRate: '10' },
        ]);
        expect(totals.subtotal).toBe('59.97');
        expect(totals.taxAmount).toBe('6.00');
        expect(totals.totalAmount).toBe('65.97');
    });

    it('numbers lines from 1 for the document', () => {
        const totals = calculateInvoice([
            { description: 'A', quantity: 1, unitPrice: '1.00', taxRate: '0' },
            { description: 'B', quantity: 1, unitPrice: '1.00', taxRate: '0' },
        ]);
        expect(totals.lines.map((line) => line.position)).toEqual([1, 2]);
    });

    it('refuses an invoice with no lines or a non-positive quantity', () => {
        expect(() => calculateInvoice([])).toThrow(/at least one line/);
        expect(() =>
            calculateInvoice([
                { description: 'A', quantity: 0, unitPrice: '1.00', taxRate: '0' },
            ]),
        ).toThrow(/non-positive quantity/);
    });
});

describe('resolveTaxConfiguration', () => {
    const base = {
        taxType: 'GST',
        hsnCode: '9706',
        sacCode: null,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
    };
    const PRODUCT = 'aaaaaaaa-0000-0000-0000-000000000001';
    const OTHER_PRODUCT = 'aaaaaaaa-0000-0000-0000-000000000002';
    const at = new Date('2026-09-15T00:00:00Z');

    const row = (
        overrides: Partial<ResolvableTaxConfiguration>,
    ): ResolvableTaxConfiguration =>
        ({ id: 'r', productId: null, countryCode: 'IN', stateCode: null, taxRate: '12.000', ...base, ...overrides }) as ResolvableTaxConfiguration;

    it('prefers the product+state row over everything else', () => {
        const winner = resolveTaxConfiguration(
            [
                row({ id: 'country-default', taxRate: '12.000' }),
                row({ id: 'state-default', stateCode: 'CA', countryCode: 'US', taxRate: '7.250' }),
                row({ id: 'product-country', productId: PRODUCT, countryCode: 'US', taxRate: '6.000' }),
                row({
                    id: 'product-state',
                    productId: PRODUCT,
                    stateCode: 'CA',
                    countryCode: 'US',
                    taxRate: '8.625',
                }),
            ],
            { productId: PRODUCT, countryCode: 'US', stateCode: 'CA', at },
        );
        expect(winner?.id).toBe('product-state');
    });

    it('falls back to the jurisdiction default when the product has no row', () => {
        const winner = resolveTaxConfiguration(
            [row({ id: 'country-default' }), row({ id: 'other', productId: OTHER_PRODUCT })],
            { productId: PRODUCT, countryCode: 'IN', stateCode: null, at },
        );
        expect(winner?.id).toBe('country-default');
    });

    it('ignores a rate whose window does not cover the invoice date', () => {
        const winner = resolveTaxConfiguration(
            [
                row({
                    id: 'old',
                    taxRate: '5.000',
                    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
                    effectiveTo: new Date('2026-04-01T00:00:00Z'),
                }),
                row({
                    id: 'current',
                    taxRate: '12.000',
                    effectiveFrom: new Date('2026-04-01T00:00:00Z'),
                }),
            ],
            { productId: PRODUCT, countryCode: 'IN', stateCode: null, at },
        );
        expect(winner?.id).toBe('current');
    });

    it('re-deriving an old invoice picks the rate that was in force then', () => {
        const rows = [
            row({
                id: 'old',
                taxRate: '5.000',
                effectiveFrom: new Date('2020-01-01T00:00:00Z'),
                effectiveTo: new Date('2026-04-01T00:00:00Z'),
            }),
            row({ id: 'current', taxRate: '12.000', effectiveFrom: new Date('2026-04-01T00:00:00Z') }),
        ];
        const winner = resolveTaxConfiguration(rows, {
            productId: PRODUCT,
            countryCode: 'IN',
            stateCode: null,
            at: new Date('2025-06-01T00:00:00Z'),
        });
        expect(winner?.id).toBe('old');
        expect(winner?.taxRate).toBe('5.000');
    });

    it('ignores another country entirely', () => {
        const winner = resolveTaxConfiguration([row({ id: 'in', countryCode: 'IN' })], {
            productId: PRODUCT,
            countryCode: 'US',
            stateCode: 'CA',
            at,
        });
        expect(winner).toBeNull();
    });

    it('returns null when nothing applies, so the caller can refuse to guess', () => {
        expect(
            resolveTaxConfiguration([], { productId: PRODUCT, countryCode: 'IN', stateCode: null, at }),
        ).toBeNull();
    });
});
