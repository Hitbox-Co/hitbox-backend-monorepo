import { describe, expect, it } from '@jest/globals';
import {
    formatInvoiceNumber,
    parseInvoiceNumber,
    toGstFilingFormat,
} from '../src/domain/invoice-number';
import {
    filingDueDate,
    fiscalYearOf,
    fiscalYearPeriod,
    monthOf,
    quarterOf,
} from '../src/domain/fiscal-calendar';
import { amountInWords } from '../src/domain/amount-in-words';

describe('fiscalYearOf', () => {
    it("uses India's April-March financial year", () => {
        expect(fiscalYearOf('IN', new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
        expect(fiscalYearOf('IN', new Date('2026-09-15T00:00:00Z'))).toBe('2026-27');
        expect(fiscalYearOf('IN', new Date('2027-03-31T23:59:59Z'))).toBe('2026-27');
        expect(fiscalYearOf('IN', new Date('2027-04-01T00:00:00Z'))).toBe('2027-28');
    });

    it('uses the calendar year everywhere else', () => {
        expect(fiscalYearOf('US', new Date('2026-01-01T00:00:00Z'))).toBe('2026');
        expect(fiscalYearOf('US', new Date('2026-12-31T23:59:59Z'))).toBe('2026');
    });

    it('decides the boundary in UTC, not local time', () => {
        // 2026-04-01T01:00 IST is 2026-03-31T19:30 UTC — the previous FY. The
        // point is that the answer does not depend on the server's timezone.
        expect(fiscalYearOf('IN', new Date('2026-03-31T19:30:00Z'))).toBe('2025-26');
    });

    it('round-trips through fiscalYearPeriod', () => {
        const period = fiscalYearPeriod('IN', '2026-27');
        expect(period.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
        expect(period.end.toISOString()).toBe('2027-04-01T00:00:00.000Z');
        expect(fiscalYearOf('IN', period.start)).toBe('2026-27');
    });
});

describe('invoice numbers', () => {
    it('formats and parses', () => {
        const number = formatInvoiceNumber({
            fiscalYear: '2026-27',
            countryCode: 'IN',
            sequence: 1234,
        });
        expect(number).toBe('INV-2026-27-IN-001234');
        expect(parseInvoiceNumber(number)).toEqual({
            fiscalYear: '2026-27',
            countryCode: 'IN',
            sequence: 1234,
        });
    });

    it('zero-pads so numbers sort lexically in the order they were issued', () => {
        const first = formatInvoiceNumber({ fiscalYear: '2026', countryCode: 'US', sequence: 9 });
        const second = formatInvoiceNumber({ fiscalYear: '2026', countryCode: 'US', sequence: 10 });
        expect([second, first].sort()).toEqual([first, second]);
    });

    it('refuses a non-positive sequence', () => {
        expect(() =>
            formatInvoiceNumber({ fiscalYear: '2026', countryCode: 'US', sequence: 0 }),
        ).toThrow(/must be positive/);
    });

    it('rejects anything that is not one of ours', () => {
        expect(parseInvoiceNumber('INVOICE-1')).toBeNull();
        expect(parseInvoiceNumber('INV-26-IN-1')).toBeNull();
    });

    it('produces a GST-legal 15-character form for filing', () => {
        // Indian GST caps an invoice number at 16 characters. The readable
        // form is 21; this is the documented shortening for the day GSTR-1
        // filing goes live.
        const short = toGstFilingFormat('INV-2026-27-IN-001234');
        expect(short).toBe('INV-2627-001234');
        expect(short.length).toBeLessThanOrEqual(16);
    });
});

describe('filing due dates', () => {
    const march = { start: new Date(Date.UTC(2026, 2, 1)), end: new Date(Date.UTC(2026, 3, 1)), label: '' };

    it('GSTR-1 is due the 11th of the following month', () => {
        expect(filingDueDate('GSTR_1', march).toISOString().slice(0, 10)).toBe('2026-04-11');
    });

    it('GSTR-3B is due the 20th of the following month', () => {
        expect(filingDueDate('GSTR_3B', march).toISOString().slice(0, 10)).toBe('2026-04-20');
    });

    it('1099-NEC is due 31 January of the following year', () => {
        const year2025 = {
            start: new Date(Date.UTC(2025, 0, 1)),
            end: new Date(Date.UTC(2026, 0, 1)),
            label: '',
        };
        expect(filingDueDate('FORM_1099_NEC', year2025).toISOString().slice(0, 10)).toBe(
            '2026-01-31',
        );
    });
});

describe('period helpers', () => {
    it('quarters are calendar quarters, matching the payout cycle', () => {
        expect(quarterOf(new Date('2026-05-04T00:00:00Z')).label).toBe('2026-Q2');
        expect(quarterOf(new Date('2026-05-04T00:00:00Z')).start.toISOString()).toBe(
            '2026-04-01T00:00:00.000Z',
        );
    });

    it('months are half-open', () => {
        const period = monthOf(new Date('2026-02-14T00:00:00Z'));
        expect(period.start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
        expect(period.end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });
});

describe('amountInWords', () => {
    it('spells rupees in the Indian numbering system', () => {
        expect(amountInWords('2240.00', 'INR')).toBe(
            'Rupees Two Thousand Two Hundred Forty Only',
        );
        expect(amountInWords('1234567.00', 'INR')).toBe(
            'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven Only',
        );
    });

    it('spells dollars in the short scale, with cents', () => {
        expect(amountInWords('27.16', 'USD')).toBe(
            'Dollars Twenty-Seven and Sixteen Cents Only',
        );
        expect(amountInWords('1900.00', 'USD')).toBe('Dollars One Thousand Nine Hundred Only');
    });

    it('handles zero and negatives', () => {
        expect(amountInWords('0.00', 'INR')).toBe('Rupees Zero Only');
        expect(amountInWords('-25.00', 'USD')).toBe('Minus Dollars Twenty-Five Only');
    });
});
