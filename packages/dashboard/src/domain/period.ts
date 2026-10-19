import { AppError } from '@hitbox/shared';
import { DASHBOARD_ERROR_CODES, TREND_GRANULARITY } from '../constants/dashboard.constant';
import type { TrendGranularity } from '../constants/dashboard.constant';

/**
 * Period resolution. Resolved **once** per request and reused by every
 * section, never recomputed per widget — otherwise two cards in the same
 * response can straddle a midnight boundary and disagree with each other.
 *
 * Ranges are half-open: `>= from AND < to`. A closed range double-counts the
 * boundary row when two adjacent periods are compared side by side, which is
 * exactly what a "this month vs last month" growth figure does.
 */

export type PeriodType = 'week' | 'month' | 'year' | 'custom';

export interface ResolvedPeriod {
    type: PeriodType;
    from: Date;
    to: Date;
    /** The immediately preceding window of equal length, for growth maths. */
    previousFrom: Date;
    previousTo: Date;
    granularity: TrendGranularity;
}

export interface PeriodInput {
    period: PeriodType;
    from?: Date | undefined;
    to?: Date | undefined;
    /** Injectable clock so tests are not time-dependent. */
    now?: Date;
}

export function resolvePeriod(input: PeriodInput): ResolvedPeriod {
    const now = input.now ?? new Date();

    if (input.period === 'custom') {
        if (!input.from || !input.to) {
            throw AppError.badRequest(
                'A custom period requires both `from` and `to`.',
                DASHBOARD_ERROR_CODES.INVALID_RANGE,
            );
        }
        if (input.from.getTime() >= input.to.getTime()) {
            throw AppError.badRequest(
                '`from` must be before `to`.',
                DASHBOARD_ERROR_CODES.INVALID_RANGE,
            );
        }
        const span = input.to.getTime() - input.from.getTime();
        return {
            type: 'custom',
            from: input.from,
            to: input.to,
            previousFrom: new Date(input.from.getTime() - span),
            previousTo: input.from,
            // A custom range long enough to be a year of data is charted by
            // month; anything shorter by day.
            granularity:
                span > 400 * DAY_MS ? TREND_GRANULARITY.month : TREND_GRANULARITY.day,
        };
    }

    const to = startOfUtcDay(now);
    // `to` is exclusive, so add a day to include today's rows.
    to.setUTCDate(to.getUTCDate() + 1);

    const from = new Date(to);
    switch (input.period) {
        case 'week':
            from.setUTCDate(from.getUTCDate() - 7);
            break;
        case 'month':
            from.setUTCMonth(from.getUTCMonth() - 1);
            break;
        case 'year':
            from.setUTCFullYear(from.getUTCFullYear() - 1);
            break;
    }

    const span = to.getTime() - from.getTime();
    return {
        type: input.period,
        from,
        to,
        previousFrom: new Date(from.getTime() - span),
        previousTo: from,
        granularity:
            input.period === 'year' ? TREND_GRANULARITY.month : TREND_GRANULARITY.day,
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(date: Date): Date {
    return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
}

/** The serialised shape returned to the client. */
export function serialisePeriod(period: ResolvedPeriod): {
    type: PeriodType;
    from: string;
    to: string;
} {
    return {
        type: period.type,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
    };
}

/**
 * Period-over-period growth, as a percentage to one decimal.
 *
 * Returns null rather than 0 or Infinity when the previous window was empty —
 * "grew from nothing" is not a percentage, and rendering it as 0% or ∞% both
 * mislead.
 */
export function growthPercentage(current: number, previous: number): number | null {
    if (previous === 0) return null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
}
