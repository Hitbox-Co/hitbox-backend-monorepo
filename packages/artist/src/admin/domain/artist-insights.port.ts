/**
 * Cross-module figures about one artist — sales, royalties, payouts, tax,
 * claims, followers — for the staff artist screens.
 *
 * The artist module owns the `Artist` row and nothing else these numbers come
 * from: orders, the royalty ledger, payouts, tax documents, claims and follows
 * all belong to other modules. So it declares what it needs here and
 * `@hitbox/dashboard` — the platform's read-only reporting module — answers
 * it (`dashboardModule.artistInsights`), wired in bootstrap. Artist never
 * queries those tables itself.
 *
 * Money is always a map keyed by currency (`{ "USD": "120.00" }`), never a
 * cross-currency total — there is no FX rate in the schema. Money fields are
 * only computed when `includeMoney` is true; otherwise they are absent.
 */

/** `{ "USD": "84210.00", "INR": "1980000.00" }` */
export type MoneyByCurrency = Partial<Record<string, string>>;

export type InsightsPeriodType = 'week' | 'month' | 'year' | 'custom';

export interface InsightsWindow {
    period: InsightsPeriodType;
    /** Required when `period` is `custom`. */
    from?: Date | undefined;
    to?: Date | undefined;
}

export interface InsightsTrendPoint {
    /** Bucket start, `2026-10-01`. */
    date: string;
    value: number;
}

export interface ArtistSalesFigures {
    /** Paid orders (PAID, PROCESSING, SHIPPED, DELIVERED). */
    orders: number;
    /** Sum of `quantity` across those orders. */
    unitsSold: number;
    /** Sum of order `amount`, per currency. Present only with money. */
    revenue?: MoneyByCurrency;
}

export interface ArtistStats {
    period: { type: InsightsPeriodType; from: string; to: string };
    sales: {
        lifetime: ArtistSalesFigures;
        period: ArtistSalesFigures;
        /** Units sold per day (week/month/custom) or per month (year), by `paidAt`. */
        trend: InsightsTrendPoint[];
    };
    /** Royalties owed to the artist. Present only with money. */
    royalties?: {
        /** Everything not reversed, net of clawbacks. */
        earned: MoneyByCurrency;
        /** Already paid out. */
        paid: MoneyByCurrency;
        /** Accrued or in a payout batch, not yet paid. */
        outstanding: MoneyByCurrency;
        /** Earned inside the window. */
        periodEarned: MoneyByCurrency;
    };
    claims: {
        /** Live claims (not revoked) on the artist's units, all time. */
        lifetime: number;
        /** Claims made inside the window. */
        period: number;
        revoked: number;
    };
    followers: {
        total: number;
        /** New follows inside the window. */
        period: number;
        /** Follower count at the end of each bucket — "followers over time". */
        trend: { date: string; new: number; total: number }[];
    };
    /** Best-selling drops, by units sold, all time. */
    topDrops: {
        id: string;
        publicCode: string | null;
        name: string;
        status: string;
        orders: number;
        unitsSold: number;
        revenue?: MoneyByCurrency;
    }[];
}

export interface ArtistAccountStatus {
    payouts: {
        /** The most recent batch, whatever its status. */
        lastPayout: {
            id: string;
            publicCode: string | null;
            status: string;
            currency: string;
            amount?: string;
            scheduledAt: string;
            paidAt: string | null;
            failureReason: string | null;
        } | null;
        /** Batches SCHEDULED or APPROVED — money on its way. */
        openBatches: number;
        failedBatches: number;
        /** Royalties accrued but not yet paid. Present only with money. */
        outstanding?: MoneyByCurrency;
        /** Everything paid out, all time. Present only with money. */
        totalPaid?: MoneyByCurrency;
    };
    tax: {
        /** Live documents (superseded ARCHIVED copies are left out). No document numbers. */
        documents: {
            id: string;
            documentType: string;
            countryCode: string;
            status: string;
            expiresAt: string | null;
            verifiedAt: string | null;
            backupWithholdingApplied: boolean;
        }[];
        /** At least one APPROVED document on file. */
        hasApprovedDocument: boolean;
        /** Any live document forces backup withholding. */
        backupWithholding: boolean;
    };
}

export interface ArtistSalesRank {
    artistId: string;
    orders: number;
    unitsSold: number;
    revenue?: MoneyByCurrency;
}

export interface IArtistInsights {
    stats(input: {
        artistId: string;
        window: InsightsWindow;
        includeMoney: boolean;
        topDrops: number;
    }): Promise<ArtistStats>;

    accountStatus(input: { artistId: string; includeMoney: boolean }): Promise<ArtistAccountStatus>;

    /** Artists ranked by units sold, all time. Artists with no sales are left out. */
    topArtistsBySales(input: {
        limit: number;
        includeMoney: boolean;
        organizationId?: string | undefined;
    }): Promise<ArtistSalesRank[]>;
}
