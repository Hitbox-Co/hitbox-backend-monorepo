import { describe, expect, it } from '@jest/globals';
import {
    addMoney,
    compareMoney,
    money,
    multiplyMoney,
    rate,
    subtractMoney,
    sumMoney,
    taxOn,
} from '../src/domain/money';

/**
 * These are the figures printed in the HitBox Tax & Invoicing Compliance Guide
 * v1.1. If one of them changes, either the guide changed or the arithmetic
 * broke, and both are worth stopping for.
 */
describe('taxOn — the figures from the compliance guide', () => {
    it('§1.1: ₹2,000 at 12% GST is ₹240', () => {
        expect(taxOn('2000.00', '12.00')).toBe('240.00');
    });

    it('§2.1: $25.00 at 8.625% sales tax is $2.16', () => {
        // The exact product is 2.15625. This is the case that proves the
        // rounding step is half-up and happens at the END, not on the rate:
        // rounding 8.625% to 8.63% first would give 2.1575 -> 2.16 by luck,
        // and 8.62% would give 2.155 -> 2.16 as well, but on a larger sale the
        // three diverge. $10,000 makes it visible.
        expect(taxOn('25.00', '8.625')).toBe('2.16');
        expect(taxOn('10000.00', '8.625')).toBe('862.50');
        expect(taxOn('10000.00', '8.63')).toBe('863.00');
    });

    it('§1.5: ₹10,00,000 at 12% is ₹1,20,000', () => {
        expect(taxOn('1000000.00', '12.00')).toBe('120000.00');
    });

    it('§1.2: TDS at 30% on ₹10,000 is ₹3,000, netting ₹7,000', () => {
        const gross = '10000.00';
        const tds = taxOn(gross, '30.00');
        expect(tds).toBe('3000.00');
        expect(subtractMoney(gross, tds)).toBe('7000.00');
    });

    it('rounds half away from zero, not to even', () => {
        // 1.005 -> 1.01, where banker's rounding would give 1.00.
        expect(taxOn('10.05', '10.00')).toBe('1.01');
        expect(taxOn('10.15', '10.00')).toBe('1.02');
    });

    it('a 0% (exempt) rate produces a real zero, not a missing value', () => {
        expect(taxOn('2000.00', '0')).toBe('0.00');
    });
});

describe('decimal arithmetic stays exact', () => {
    it('adds without float drift', () => {
        // 0.1 + 0.2 is the canonical float failure; here it must be 0.30.
        expect(addMoney('0.10', '0.20')).toBe('0.30');
        expect(sumMoney(Array.from({ length: 10 }, () => '0.10'))).toBe('1.00');
    });

    it('multiplies a unit price by a quantity', () => {
        expect(multiplyMoney('19.99', 3)).toBe('59.97');
        expect(multiplyMoney('2000.00', 1)).toBe('2000.00');
    });

    it('sums an empty list to zero rather than failing', () => {
        expect(sumMoney([])).toBe('0.00');
    });

    it('handles negatives, which a refund adjustment produces', () => {
        expect(subtractMoney('2.16', '27.16')).toBe('-25.00');
        expect(sumMoney(['-2.16', '2.16'])).toBe('0.00');
    });

    it('compares without converting to number', () => {
        expect(compareMoney('600.00', '600.00')).toBe(0);
        expect(compareMoney('599.99', '600.00')).toBe(-1);
        expect(compareMoney('600.01', '600.00')).toBe(1);
    });

    it('normalises to two places', () => {
        expect(money('5')).toBe('5.00');
        expect(money('5.1')).toBe('5.10');
        expect(money('5.005')).toBe('5.01');
    });
});

describe('rate', () => {
    it('keeps three decimals so US local rates survive', () => {
        expect(rate('8.625')).toBe('8.625');
        expect(rate('8.875')).toBe('8.875');
    });

    it('pads whole percentages', () => {
        expect(rate('12')).toBe('12.000');
    });
});

describe('malformed input', () => {
    it('refuses anything that is not a decimal', () => {
        expect(() => money('1,000.00')).toThrow(/Not a decimal/);
        expect(() => money('twelve')).toThrow(/Not a decimal/);
        expect(() => taxOn('2000.00', '12%')).toThrow(/Not a decimal/);
    });
});
