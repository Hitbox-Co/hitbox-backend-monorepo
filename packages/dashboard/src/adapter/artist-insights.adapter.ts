import { money, sumByCurrency } from '../domain/money';
import type { MoneyByCurrency } from '../domain/money';
import { resolvePeriod, serialisePeriod } from '../domain/period';
import type { PeriodType } from '../domain/period';
import type { ArtistInsightsRepository } from '../repository/artist-insights.repository';

/**
 * Implements @hitbox/artist's `IArtistInsights` port — the figures the staff
 * artist screens need from tables other modules own: orders, the royalty
 * ledger, payouts, tax documents, claims and follows.
 *
 * Structural: artist declares the port, this satisfies it, bootstrap passes
 * `dashboardModule.artistInsights` in. Neither package imports the other.
 *
 * Money keys are only computed — never just hidden — when `includeMoney` is
 * true. The caller decides that from `payment-royalty:read`, the dashboard's
 * rule for every monetary figure.
 */

interface Window {
    period: PeriodType;
    from?: Date | undefined;
    to?: Date | undefined;
}

export class ArtistInsightsAdapter {
    constructor(private readonly repository: ArtistInsightsRepository) { }

    async stats(input: { artistId: string; window: Window; includeMoney: boolean; topDrops: number }) {
        const { artistId, includeMoney } = input;
        const period = resolvePeriod(input.window);

        const [sales, trend, royalties, claims, followers, top] = await Promise.all([
            this.repository.sales(artistId, period),
            this.repository.salesTrend(artistId, period),
            includeMoney ? this.repository.royalties(artistId, period) : Promise.resolve(null),
            this.repository.claims(artistId, period),
            this.repository.followers(artistId, period),
            this.repository.topDrops(artistId, input.topDrops),
        ]);

        const revenueByDrop = includeMoney
            ? groupMoney(await this.repository.revenueByDrop(top.map((d) => d.id)), (r) => r.dropId)
            : null;

        let running = followers.before;
        return {
            period: serialisePeriod(period),
            sales: {
                lifetime: {
                    orders: total(sales, (r) => r.orders),
                    unitsSold: total(sales, (r) => r.units),
                    ...(includeMoney && { revenue: sumByCurrency(sales.map((r) => ({ currency: r.currency, amount: r.amount }))) }),
                },
                period: {
                    orders: total(sales, (r) => r.p_orders),
                    unitsSold: total(sales, (r) => r.p_units),
                    ...(includeMoney && { revenue: sumByCurrency(sales.map((r) => ({ currency: r.currency, amount: r.p_amount }))) }),
                },
                trend: trend.map((p) => ({ date: bucketKey(p.bucket), value: Number(p.value ?? 0) })),
            },
            ...(royalties && {
                royalties: {
                    earned: sumByCurrency(royalties.map((r) => ({ currency: r.currency, amount: r.earned }))),
                    paid: sumByCurrency(royalties.map((r) => ({ currency: r.currency, amount: r.paid }))),
                    outstanding: sumByCurrency(royalties.map((r) => ({ currency: r.currency, amount: r.outstanding }))),
                    periodEarned: sumByCurrency(royalties.map((r) => ({ currency: r.currency, amount: r.period_earned }))),
                },
            }),
            claims: { lifetime: claims.live, period: claims.inWindow, revoked: claims.revoked },
            followers: {
                total: followers.total,
                period: followers.inWindow,
                trend: followers.buckets.map((b) => {
                    running += b.value;
                    return { date: bucketKey(b.bucket), new: b.value, total: running };
                }),
            },
            topDrops: top.map((d) => ({
                id: d.id,
                publicCode: d.publicCode,
                name: d.name,
                status: d.status,
                orders: Number(d.orders ?? 0),
                unitsSold: Number(d.units ?? 0),
                ...(revenueByDrop && { revenue: revenueByDrop.get(d.id) ?? {} }),
            })),
        };
    }

    async accountStatus(input: { artistId: string; includeMoney: boolean }) {
        const { artistId, includeMoney } = input;
        const [payouts, documents, paid, outstanding] = await Promise.all([
            this.repository.payouts(artistId),
            this.repository.taxDocuments(artistId),
            includeMoney ? this.repository.paidPayouts(artistId) : Promise.resolve(null),
            includeMoney ? this.repository.outstandingRoyalties(artistId) : Promise.resolve(null),
        ]);
        const last = payouts.last;

        return {
            payouts: {
                lastPayout: last
                    ? {
                        id: last.id,
                        publicCode: last.publicCode,
                        status: last.status,
                        currency: last.currency,
                        ...(includeMoney && { amount: money(last.amount) }),
                        scheduledAt: last.scheduledAt.toISOString(),
                        paidAt: last.paidAt?.toISOString() ?? null,
                        failureReason: last.failureReason,
                    }
                    : null,
                openBatches: (payouts.counts.SCHEDULED ?? 0) + (payouts.counts.APPROVED ?? 0),
                failedBatches: payouts.counts.FAILED ?? 0,
                ...(outstanding && {
                    outstanding: sumByCurrency(outstanding.map((r) => ({ currency: r.currency, amount: r._sum.amount }))),
                }),
                ...(paid && {
                    totalPaid: sumByCurrency(paid.map((r) => ({ currency: r.currency, amount: r._sum.amount }))),
                }),
            },
            tax: {
                documents: documents.map((d) => ({
                    id: d.id,
                    documentType: d.documentType,
                    countryCode: d.countryCode,
                    status: d.status,
                    expiresAt: d.expiresAt?.toISOString() ?? null,
                    verifiedAt: d.verifiedAt?.toISOString() ?? null,
                    backupWithholdingApplied: d.backupWithholdingApplied,
                })),
                hasApprovedDocument: documents.some((d) => d.status === 'APPROVED'),
                backupWithholding: documents.some((d) => d.backupWithholdingApplied),
            },
        };
    }

    async topArtistsBySales(input: { limit: number; includeMoney: boolean; organizationId?: string | undefined }) {
        const ranks = await this.repository.topArtists(input.limit, input.organizationId);
        const revenue = input.includeMoney
            ? groupMoney(await this.repository.revenueByArtist(ranks.map((r) => r.artistId)), (r) => r.artistId)
            : null;
        return ranks.map((r) => ({
            artistId: r.artistId,
            orders: Number(r.orders ?? 0),
            unitsSold: Number(r.units ?? 0),
            ...(revenue && { revenue: revenue.get(r.artistId) ?? {} }),
        }));
    }
}

function total<T>(rows: T[], pick: (row: T) => bigint | number | null): number {
    return rows.reduce((sum, row) => sum + Number(pick(row) ?? 0), 0);
}

function groupMoney<T extends { currency: Parameters<typeof sumByCurrency>[0][number]['currency']; amount: Parameters<typeof sumByCurrency>[0][number]['amount'] }>(
    rows: T[],
    key: (row: T) => string,
): Map<string, MoneyByCurrency> {
    const grouped = new Map<string, T[]>();
    for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
    return new Map([...grouped].map(([id, list]) => [id, sumByCurrency(list)]));
}

/** `2026-08-01T00:00:00Z` -> `2026-08-01`. */
function bucketKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}
