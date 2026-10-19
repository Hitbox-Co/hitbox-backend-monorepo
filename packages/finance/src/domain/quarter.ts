import { QUARTER_START_MONTHS } from '../constants/finance.constant';

/**
 * Quarter arithmetic for the payout sweep. Everything is UTC: the boundaries
 * are Jan 1, Apr 1, Jul 1 and Oct 1 at 00:00 UTC, whatever the server's zone.
 */

/** The start of the quarter containing `at` — the most recent boundary at or before it. */
export function currentQuarterBoundary(at: Date): Date {
    const month = at.getUTCMonth();
    const startMonth = [...QUARTER_START_MONTHS].reverse().find((m) => m <= month) ?? 0;
    return new Date(Date.UTC(at.getUTCFullYear(), startMonth, 1, 0, 0, 0, 0));
}

/** The next boundary strictly after `at`. */
export function nextQuarterBoundary(at: Date): Date {
    const current = currentQuarterBoundary(at);
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 3, 1, 0, 0, 0, 0));
}

/** The quarter a sweep run at `boundary` settles: [start, boundary). */
export function quarterEndingAt(boundary: Date): { start: Date; end: Date } {
    return {
        start: new Date(
            Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth() - 3, 1, 0, 0, 0, 0),
        ),
        end: boundary,
    };
}

/** "2026-Q3" — for logs and audit payloads. */
export function quarterLabel(start: Date): string {
    return `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
}
