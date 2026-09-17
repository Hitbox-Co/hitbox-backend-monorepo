/**
 * Fiscal calendars, which differ between the two jurisdictions and which the
 * invoice series, the GSTR filing periods and the 1099 reporting year all key
 * off.
 *
 *   **India** — the financial year runs 1 April to 31 March and is written
 *   `2026-27`. GST invoice numbering must restart each financial year, and a
 *   Form 16A is issued for the FY, not the calendar year.
 *
 *   **United States** — the tax year is the calendar year, written `2026`.
 *   1099-NEC Box 1 sums a calendar year, and the sales-tax quarters are the
 *   standard calendar quarters.
 *
 * Everything here works in UTC. Invoice dates are stored as instants and the
 * boundary between two fiscal years is a legal fact about a date, not about a
 * viewer's timezone — deriving it from local time would put an invoice issued
 * at 01:00 IST on 1 April into the previous year's series on a server in
 * another region.
 */

export const IN = 'IN' as const;
export const US = 'US' as const;

/** The fiscal year label an invoice in this jurisdiction belongs to. */
export function fiscalYearOf(countryCode: string, at: Date): string {
    const year = at.getUTCFullYear();
    if (countryCode !== IN) return String(year);

    // April (month index 3) starts the Indian FY.
    const startYear = at.getUTCMonth() >= 3 ? year : year - 1;
    const endShort = String((startYear + 1) % 100).padStart(2, '0');
    return `${startYear}-${endShort}`;
}

export interface FiscalPeriod {
    /** Inclusive. */
    start: Date;
    /** Exclusive — the instant the next period begins. Half-open so a filing
     *  query is `>= start AND < end` with no last-millisecond edge case. */
    end: Date;
    label: string;
}

/** The fiscal year as a half-open instant range. */
export function fiscalYearPeriod(countryCode: string, label: string): FiscalPeriod {
    if (countryCode === IN) {
        const startYear = Number(label.slice(0, 4));
        if (!/^\d{4}-\d{2}$/.test(label) || Number.isNaN(startYear)) {
            throw new Error(`Not an Indian fiscal year label: "${label}" (expected e.g. 2026-27)`);
        }
        return {
            start: new Date(Date.UTC(startYear, 3, 1)),
            end: new Date(Date.UTC(startYear + 1, 3, 1)),
            label,
        };
    }
    const year = Number(label);
    if (!/^\d{4}$/.test(label) || Number.isNaN(year)) {
        throw new Error(`Not a calendar year label: "${label}" (expected e.g. 2026)`);
    }
    return {
        start: new Date(Date.UTC(year, 0, 1)),
        end: new Date(Date.UTC(year + 1, 0, 1)),
        label,
    };
}

/**
 * The standard quarter containing `at`, on calendar boundaries (Jan 1 / Apr 1 /
 * Jul 1 / Oct 1) in both jurisdictions.
 *
 * Deliberately calendar quarters even for India, where the FY starts in April:
 * these are the boundaries the royalty payout queue aggregates on (compliance
 * guide §1.2), so a Form 16A quarter and a payout quarter are the same range.
 */
export function quarterOf(at: Date): FiscalPeriod {
    const year = at.getUTCFullYear();
    const index = Math.floor(at.getUTCMonth() / 3);
    return {
        start: new Date(Date.UTC(year, index * 3, 1)),
        end: new Date(Date.UTC(year, index * 3 + 3, 1)),
        label: `${year}-Q${index + 1}`,
    };
}

/** The calendar month containing `at` — the GSTR-1 / GSTR-3B period. */
export function monthOf(at: Date): FiscalPeriod {
    const year = at.getUTCFullYear();
    const month = at.getUTCMonth();
    return {
        start: new Date(Date.UTC(year, month, 1)),
        end: new Date(Date.UTC(year, month + 1, 1)),
        label: `${year}-${String(month + 1).padStart(2, '0')}`,
    };
}

/**
 * Statutory due dates, as the compliance guide states them (§1.5, §2.2).
 *
 * Returned rather than stored so a filing row created for a period always
 * carries the right deadline, and so changing a deadline is one edit here
 * rather than a data migration.
 */
export function filingDueDate(
    filingType: 'GSTR_1' | 'GSTR_3B' | 'FORM_16A' | 'FORM_1099_NEC' | 'STATE_SALES_TAX',
    period: FiscalPeriod,
): Date {
    const endsIn = new Date(period.end.getTime() - 1);
    const year = endsIn.getUTCFullYear();
    const month = endsIn.getUTCMonth();

    switch (filingType) {
        // 11th of the month following the reporting month.
        case 'GSTR_1':
            return new Date(Date.UTC(year, month + 1, 11));
        // 20th of the month following the reporting month.
        case 'GSTR_3B':
            return new Date(Date.UTC(year, month + 1, 20));
        // 20th of the month following the quarter.
        case 'STATE_SALES_TAX':
            return new Date(Date.UTC(year, month + 1, 20));
        // TDS certificates for a financial year are issued by 31 March.
        case 'FORM_16A':
            return new Date(Date.UTC(month >= 3 ? year + 1 : year, 2, 31));
        // Furnished to the recipient and filed with the IRS by 31 January.
        case 'FORM_1099_NEC':
            return new Date(Date.UTC(year + 1, 0, 31));
    }
}
