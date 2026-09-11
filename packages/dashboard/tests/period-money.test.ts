import { INTERNAL_ADMIN_ROLE_NAMES, isInternalAdminUser } from '../src/domain/admin-classification';
import { addMoney, money, subtractMoney, sumByCurrency } from '../src/domain/money';
import { growthPercentage, resolvePeriod, serialisePeriod } from '../src/domain/period';

const NOW = new Date('2026-09-11T13:45:00Z');

describe('period resolution', () => {
    it('uses a half-open range so adjacent periods never double-count', () => {
        const period = resolvePeriod({ period: 'month', now: NOW });
        // `to` is exclusive and the previous window ends exactly where this
        // one starts, so a row on the boundary belongs to one period only.
        expect(period.previousTo.getTime()).toBe(period.from.getTime());
    });

    it('includes today', () => {
        const period = resolvePeriod({ period: 'week', now: NOW });
        expect(period.to.toISOString()).toBe('2026-09-12T00:00:00.000Z');
        expect(period.from.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    });

    it('gives the previous window the same length', () => {
        for (const type of ['week', 'month', 'year'] as const) {
            const p = resolvePeriod({ period: type, now: NOW });
            expect(p.to.getTime() - p.from.getTime()).toBe(
                p.previousTo.getTime() - p.previousFrom.getTime(),
            );
        }
    });

    it('buckets a year by month and shorter periods by day', () => {
        expect(resolvePeriod({ period: 'year', now: NOW }).granularity).toBe('month');
        expect(resolvePeriod({ period: 'month', now: NOW }).granularity).toBe('day');
        expect(resolvePeriod({ period: 'week', now: NOW }).granularity).toBe('day');
    });

    it('accepts a custom range', () => {
        const period = resolvePeriod({
            period: 'custom',
            from: new Date('2026-01-01T00:00:00Z'),
            to: new Date('2026-02-01T00:00:00Z'),
            now: NOW,
        });
        expect(serialisePeriod(period)).toEqual({
            type: 'custom',
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-02-01T00:00:00.000Z',
        });
        expect(period.previousFrom.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    });

    it('rejects a custom range that is missing a bound or inverted', () => {
        expect(() => resolvePeriod({ period: 'custom', from: NOW })).toThrow(/requires both/);
        expect(() =>
            resolvePeriod({
                period: 'custom',
                from: new Date('2026-02-01T00:00:00Z'),
                to: new Date('2026-01-01T00:00:00Z'),
            }),
        ).toThrow(/must be before/);
    });
});

describe('growth percentage', () => {
    it('computes period-over-period change to one decimal', () => {
        expect(growthPercentage(112, 100)).toBe(12);
        expect(growthPercentage(87, 100)).toBe(-13);
        expect(growthPercentage(1284, 1142)).toBe(12.4);
    });

    it('returns null rather than 0 or Infinity when the previous window was empty', () => {
        // "Grew from nothing" is not a percentage; rendering it as 0% or ∞%
        // both mislead, so the client decides how to show "no baseline".
        expect(growthPercentage(50, 0)).toBeNull();
        expect(growthPercentage(0, 0)).toBeNull();
    });
});

describe('money', () => {
    it('keys every total by currency', () => {
        expect(
            sumByCurrency([
                { currency: 'USD', amount: '100.50' },
                { currency: 'USD', amount: '20.25' },
                { currency: 'INR', amount: '5000' },
            ]),
        ).toEqual({ INR: '5000.00', USD: '120.75' });
    });

    it('never sums across currencies', () => {
        // The schema has no FX rate anywhere, so a combined total would be an
        // invented exchange rate applied silently at report time.
        const total = addMoney({ USD: '100.00' }, { INR: '8000.00' });
        expect(total).toEqual({ INR: '8000.00', USD: '100.00' });
        expect(Object.keys(total)).toHaveLength(2);
    });

    it('subtracts per currency', () => {
        expect(
            subtractMoney({ USD: '1000.00', INR: '5000.00' }, { USD: '250.00' }),
        ).toEqual({ INR: '5000.00', USD: '750.00' });
    });

    it('keeps a negative when a refund has no matching collection', () => {
        // Dropping it would make the books look balanced when they are not.
        expect(subtractMoney({}, { USD: '40.00' })).toEqual({ USD: '-40.00' });
    });

    it('carries decimals exactly rather than through a float', () => {
        const total = sumByCurrency([
            { currency: 'INR', amount: '1980000.01' },
            { currency: 'INR', amount: '0.02' },
        ]);
        expect(total.INR).toBe('1980000.03');
    });

    it('renders a single value to two places', () => {
        expect(money('7')).toBe('7.00');
        expect(money(null)).toBe('0.00');
    });

    it('treats a missing amount as zero, not as NaN', () => {
        expect(sumByCurrency([{ currency: 'USD', amount: null }])).toEqual({ USD: '0.00' });
    });
});

describe('internal admin classification', () => {
    it('counts the eight internal HitBox roles', () => {
        expect(INTERNAL_ADMIN_ROLE_NAMES).toHaveLength(8);
        expect(isInternalAdminUser(['HITBOX_SUPPORT'])).toBe(true);
        expect(isInternalAdminUser(['HITBOX_PLATFORM_ENGINEER'])).toBe(true);
    });

    it('excludes brand staff — commercial partners, not HitBox headcount', () => {
        expect(isInternalAdminUser(['BRAND_ADMIN'])).toBe(false);
        expect(isInternalAdminUser(['BRAND_EMPLOYEE'])).toBe(false);
    });

    it('excludes artists and plain buyers', () => {
        expect(isInternalAdminUser(['ARTIST'])).toBe(false);
        expect(isInternalAdminUser(['BUYER_COLLECTOR'])).toBe(false);
        expect(isInternalAdminUser([])).toBe(false);
    });

    it('classifies a user holding both kinds as internal, once', () => {
        // Counted under adminUsers only — never in both buckets, or
        // newUsers + newAdmins would exceed the real signup count.
        expect(isInternalAdminUser(['ARTIST', 'HITBOX_SUPPORT'])).toBe(true);
    });

    it('does not include HITBOX_DB_ADMIN', () => {
        expect(INTERNAL_ADMIN_ROLE_NAMES).not.toContain('HITBOX_DB_ADMIN');
        expect(isInternalAdminUser(['HITBOX_DB_ADMIN'])).toBe(false);
    });
});
