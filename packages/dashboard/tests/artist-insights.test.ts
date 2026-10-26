import { Prisma } from '@hitbox/database';
import { ArtistInsightsAdapter } from '../src/adapter/artist-insights.adapter';
import type { ArtistInsightsRepository } from '../src/repository/artist-insights.repository';

/**
 * The artist-insights adapter's shaping: money only when asked for, per
 * currency; followers over time as a running total; top drops with revenue.
 * The SQL itself is exercised against a real database, not here.
 */

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const dec = (v: string) => new Prisma.Decimal(v);

function fakeRepository(calls: string[]) {
    return {
        sales: async () => [
            { currency: 'USD', orders: 2n, units: 3n, amount: dec('30'), p_orders: 1n, p_units: 1n, p_amount: dec('10') },
            { currency: 'INR', orders: 1n, units: 1n, amount: dec('900'), p_orders: 0n, p_units: 0n, p_amount: dec('0') },
        ],
        salesTrend: async () => [{ bucket: new Date('2026-10-01T00:00:00Z'), value: 1n }],
        royalties: async () => {
            calls.push('royalties');
            return [{ currency: 'USD', earned: dec('3'), paid: dec('1'), outstanding: dec('2'), period_earned: dec('1') }];
        },
        claims: async () => ({ live: 2, inWindow: 1, revoked: 1 }),
        followers: async () => ({
            total: 10, before: 6, inWindow: 4,
            buckets: [
                { bucket: new Date('2026-09-01T00:00:00Z'), value: 1 },
                { bucket: new Date('2026-10-01T00:00:00Z'), value: 3 },
            ],
        }),
        topDrops: async () => [{ id: 'd1', publicCode: 'drp1', name: 'Tee', status: 'ACTIVE', orders: 2n, units: 3n }],
        revenueByDrop: async () => {
            calls.push('revenueByDrop');
            return [{ dropId: 'd1', currency: 'USD', amount: dec('30') }];
        },
        topArtists: async () => [{ artistId: ARTIST, orders: 3n, units: 4n }],
        revenueByArtist: async () => {
            calls.push('revenueByArtist');
            return [{ artistId: ARTIST, currency: 'USD', amount: dec('30') }, { artistId: ARTIST, currency: 'INR', amount: dec('900') }];
        },
        payouts: async () => ({
            last: {
                id: 'p1', publicCode: 'pyo1', status: 'PAID', currency: 'USD', amount: dec('1'),
                scheduledAt: new Date('2026-10-01T00:00:00Z'), paidAt: new Date('2026-10-02T00:00:00Z'), failureReason: null,
            },
            counts: { PAID: 1, SCHEDULED: 1, APPROVED: 1, FAILED: 2 },
        }),
        paidPayouts: async () => {
            calls.push('paidPayouts');
            return [{ currency: 'USD', _sum: { amount: dec('1') } }];
        },
        outstandingRoyalties: async () => {
            calls.push('outstandingRoyalties');
            return [{ currency: 'USD', _sum: { amount: dec('2') } }];
        },
        taxDocuments: async () => [
            { id: 't1', documentType: 'W9', countryCode: 'US', status: 'APPROVED', expiresAt: null, verifiedAt: null, backupWithholdingApplied: false },
        ],
    } as unknown as ArtistInsightsRepository;
}

describe('ArtistInsightsAdapter', () => {
    it('stats: counts across currencies, money per currency, followers as a running total', async () => {
        const calls: string[] = [];
        const adapter = new ArtistInsightsAdapter(fakeRepository(calls));
        const stats = await adapter.stats({ artistId: ARTIST, window: { period: 'year' }, includeMoney: true, topDrops: 5 });

        expect(stats.sales.lifetime).toEqual({ orders: 3, unitsSold: 4, revenue: { INR: '900.00', USD: '30.00' } });
        expect(stats.sales.period).toEqual({ orders: 1, unitsSold: 1, revenue: { INR: '0.00', USD: '10.00' } });
        expect(stats.sales.trend).toEqual([{ date: '2026-10-01', value: 1 }]);
        expect(stats.royalties).toEqual({
            earned: { USD: '3.00' }, paid: { USD: '1.00' }, outstanding: { USD: '2.00' }, periodEarned: { USD: '1.00' },
        });
        expect(stats.followers.trend).toEqual([
            { date: '2026-09-01', new: 1, total: 7 },
            { date: '2026-10-01', new: 3, total: 10 },
        ]);
        expect(stats.topDrops).toEqual([
            { id: 'd1', publicCode: 'drp1', name: 'Tee', status: 'ACTIVE', orders: 2, unitsSold: 3, revenue: { USD: '30.00' } },
        ]);
    });

    it('stats without money: no money keys, and the money queries never run', async () => {
        const calls: string[] = [];
        const stats = await new ArtistInsightsAdapter(fakeRepository(calls)).stats({
            artistId: ARTIST, window: { period: 'month' }, includeMoney: false, topDrops: 5,
        });
        expect(stats.sales.lifetime).not.toHaveProperty('revenue');
        expect(stats).not.toHaveProperty('royalties');
        expect(stats.topDrops[0]).not.toHaveProperty('revenue');
        expect(calls).toEqual([]);
    });

    it('accountStatus: batch counts, amounts only with money, tax status without numbers', async () => {
        const calls: string[] = [];
        const adapter = new ArtistInsightsAdapter(fakeRepository(calls));
        const withMoney = await adapter.accountStatus({ artistId: ARTIST, includeMoney: true });
        expect(withMoney.payouts).toMatchObject({
            openBatches: 2, failedBatches: 2, outstanding: { USD: '2.00' }, totalPaid: { USD: '1.00' },
            lastPayout: { id: 'p1', amount: '1.00', paidAt: '2026-10-02T00:00:00.000Z' },
        });
        expect(withMoney.tax).toMatchObject({ hasApprovedDocument: true, backupWithholding: false });

        calls.length = 0;
        const without = await adapter.accountStatus({ artistId: ARTIST, includeMoney: false });
        expect(without.payouts).not.toHaveProperty('outstanding');
        expect(without.payouts).not.toHaveProperty('totalPaid');
        expect(without.payouts.lastPayout).not.toHaveProperty('amount');
        expect(calls).toEqual([]);
    });

    it('topArtistsBySales: units, plus revenue per currency with money', async () => {
        const adapter = new ArtistInsightsAdapter(fakeRepository([]));
        expect(await adapter.topArtistsBySales({ limit: 5, includeMoney: true })).toEqual([
            { artistId: ARTIST, orders: 3, unitsSold: 4, revenue: { INR: '900.00', USD: '30.00' } },
        ]);
        expect(await adapter.topArtistsBySales({ limit: 5, includeMoney: false })).toEqual([
            { artistId: ARTIST, orders: 3, unitsSold: 4 },
        ]);
    });
});
