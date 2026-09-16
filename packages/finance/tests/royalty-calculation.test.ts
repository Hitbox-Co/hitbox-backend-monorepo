import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import {
    accrualKeyFor,
    calculateRoyalty,
    resolveRule,
    splitsOf,
} from '../src/domain/royalty-calculation';

const D = (value: string | number) => new Prisma.Decimal(value);

describe('calculateRoyalty', () => {
    /**
     * The design document's worked example, verbatim:
     *
     *     $100 gross, $25 COGS, 15% → $75 × 0.15 = $11.25
     *
     * This is the assertion the whole royalty system exists to satisfy, so it
     * is checked against the real code path rather than a reimplementation.
     */
    it('matches the design document: $100 gross, $25 COGS, 15% = $11.25', () => {
        const result = calculateRoyalty({
            grossRevenue: D('100.00'),
            costOfGoods: D('25.00'),
            basis: 'NET_PROFIT',
            percentage: D('15'),
        });

        expect(result.netProfit.toFixed(2)).toBe('75.00');
        expect(result.amount.toFixed(2)).toBe('11.25');
    });

    it('ignores cost of goods on the GROSS_REVENUE basis', () => {
        const result = calculateRoyalty({
            grossRevenue: D('100.00'),
            costOfGoods: D('25.00'),
            basis: 'GROSS_REVENUE',
            percentage: D('15'),
        });

        expect(result.base.toFixed(2)).toBe('100.00');
        expect(result.amount.toFixed(2)).toBe('15.00');
    });

    it('treats a missing cost of goods as zero', () => {
        const result = calculateRoyalty({
            grossRevenue: D('50.00'),
            costOfGoods: null,
            basis: 'NET_PROFIT',
            percentage: D('10'),
        });

        expect(result.costOfGoods.toFixed(2)).toBe('0.00');
        expect(result.amount.toFixed(2)).toBe('5.00');
    });

    /**
     * A sale below cost owes the artist nothing rather than owing HitBox money
     * back — a negative accrual would net against unrelated sales and silently
     * reduce a payout the artist has already been told about.
     */
    it('floors a below-cost sale at zero instead of going negative', () => {
        const result = calculateRoyalty({
            grossRevenue: D('20.00'),
            costOfGoods: D('25.00'),
            basis: 'NET_PROFIT',
            percentage: D('15'),
        });

        expect(result.netProfit.toFixed(2)).toBe('0.00');
        expect(result.amount.toFixed(2)).toBe('0.00');
        expect(result.amount.isNegative()).toBe(false);
    });

    it('rounds half up to two decimal places', () => {
        // 33.33 × 12.5% = 4.16625 → 4.17
        const result = calculateRoyalty({
            grossRevenue: D('33.33'),
            costOfGoods: null,
            basis: 'GROSS_REVENUE',
            percentage: D('12.5'),
        });
        expect(result.amount.toFixed(2)).toBe('4.17');
    });

    it('refuses a percentage outside 0–100', () => {
        expect(() =>
            calculateRoyalty({
                grossRevenue: D('100'),
                costOfGoods: null,
                basis: 'NET_PROFIT',
                percentage: D('150'),
            }),
        ).toThrow(/between 0 and 100/);
    });

    /**
     * Decimal arithmetic end to end: 0.1 + 0.2 is not 0.3 in a float, and a
     * ledger that is append-only cannot quietly fix a rounding error later.
     */
    it('does not accumulate floating-point drift across many accruals', () => {
        let total = D(0);
        for (let i = 0; i < 1000; i += 1) {
            total = total.plus(
                calculateRoyalty({
                    grossRevenue: D('0.10'),
                    costOfGoods: null,
                    basis: 'GROSS_REVENUE',
                    percentage: D('10'),
                }).amount,
            );
        }
        // 1000 × (0.10 × 10%) = 1000 × 0.01 = 10.00, exactly.
        expect(total.toFixed(2)).toBe('10.00');
    });
});

describe('resolveRule', () => {
    const base = {
        productId: null,
        collectionId: null,
        artistId: null,
        organizationId: null,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null as Date | null,
    };
    const at = new Date('2026-06-01');

    it('prefers the product rule over collection, artist and organization', () => {
        const winner = resolveRule(
            [
                { ...base, id: 'org', organizationId: 'o1' },
                { ...base, id: 'artist', artistId: 'a1' },
                { ...base, id: 'collection', collectionId: 'c1' },
                { ...base, id: 'product', productId: 'p1' },
            ],
            at,
        );
        expect(winner?.id).toBe('product');
    });

    it('falls back down the chain when the specific scopes have no rule', () => {
        const winner = resolveRule(
            [
                { ...base, id: 'org', organizationId: 'o1' },
                { ...base, id: 'artist', artistId: 'a1' },
            ],
            at,
        );
        expect(winner?.id).toBe('artist');
    });

    /**
     * The versioning property: a renegotiation closes the old rule and opens a
     * new one, and re-running an old order still reproduces the old number.
     */
    it('picks the version in force at the moment of the accrual, not the newest', () => {
        const rules = [
            {
                ...base,
                id: 'old',
                artistId: 'a1',
                effectiveFrom: new Date('2026-01-01'),
                effectiveTo: new Date('2026-03-01'),
            },
            {
                ...base,
                id: 'new',
                artistId: 'a1',
                effectiveFrom: new Date('2026-03-01'),
            },
        ];

        expect(resolveRule(rules, new Date('2026-02-01'))?.id).toBe('old');
        expect(resolveRule(rules, new Date('2026-06-01'))?.id).toBe('new');
    });

    it('returns null when no rule is in force yet', () => {
        expect(
            resolveRule([{ ...base, id: 'future', artistId: 'a1', effectiveFrom: new Date('2027-01-01') }], at),
        ).toBeNull();
    });

    it('breaks a tie at the same scope by the later effectiveFrom', () => {
        const winner = resolveRule(
            [
                { ...base, id: 'older', artistId: 'a1', effectiveFrom: new Date('2026-01-01') },
                { ...base, id: 'newer', artistId: 'a1', effectiveFrom: new Date('2026-05-01') },
            ],
            at,
        );
        expect(winner?.id).toBe('newer');
    });
});

describe('splitsOf', () => {
    it('falls back to the percentage column paid to the rule’s artist', () => {
        const splits = splitsOf(
            { percentage: D('15'), splitConfig: {}, artistId: 'a1', organizationId: null },
            null,
        );
        expect(splits).toHaveLength(1);
        expect(splits[0]?.payeeType).toBe('ARTIST');
        expect(splits[0]?.artistId).toBe('a1');
        expect(splits[0]?.percentage.toString()).toBe('15');
    });

    it('uses the order’s artist when the rule is scoped to a product', () => {
        const splits = splitsOf(
            { percentage: D('10'), splitConfig: {}, artistId: null, organizationId: null },
            'artist-from-order',
        );
        expect(splits[0]?.artistId).toBe('artist-from-order');
    });

    it('reads a multi-party split configuration', () => {
        const splits = splitsOf(
            {
                percentage: null,
                splitConfig: {
                    splits: [
                        { payeeType: 'ARTIST', artistId: 'a1', percentage: 10 },
                        { payeeType: 'ORGANIZATION', organizationId: 'o1', percentage: 5 },
                    ],
                },
                artistId: null,
                organizationId: null,
            },
            null,
        );

        expect(splits).toHaveLength(2);
        expect(splits[1]?.payeeType).toBe('ORGANIZATION');
        expect(splits[1]?.organizationId).toBe('o1');
    });

    /** A split that names no payee cannot be paid to anyone. */
    it('drops a split with no payee rather than defaulting it', () => {
        const splits = splitsOf(
            {
                percentage: D('15'),
                splitConfig: { splits: [{ payeeType: 'ARTIST', percentage: 10 }] },
                artistId: 'a1',
                organizationId: null,
            },
            null,
        );
        // The malformed split is skipped, so the percentage fallback applies.
        expect(splits).toHaveLength(1);
        expect(splits[0]?.percentage.toString()).toBe('15');
    });

    it('refuses a rule with neither a percentage nor a usable split', () => {
        expect(() =>
            splitsOf({ percentage: null, splitConfig: {}, artistId: 'a1', organizationId: null }, null),
        ).toThrow(/percentage|split/i);
    });
});

describe('accrualKeyFor', () => {
    /**
     * The key is a UNIQUE column, and it is the whole duplicate-accrual
     * defence: it must be identical for a replay and different for a second
     * legitimate payee.
     */
    it('is stable for the same claim, rule and payee', () => {
        expect(accrualKeyFor('c1', 'r1', 'p1')).toBe(accrualKeyFor('c1', 'r1', 'p1'));
    });

    it('differs per payee, so a two-way split writes two rows', () => {
        expect(accrualKeyFor('c1', 'r1', 'p1')).not.toBe(accrualKeyFor('c1', 'r1', 'p2'));
    });
});
