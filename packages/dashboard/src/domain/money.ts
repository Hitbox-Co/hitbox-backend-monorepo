import { Prisma } from '@hitbox/database';
import type { Currency } from '@hitbox/database';

/**
 * Money in this dashboard is **always** a map keyed by ISO currency code:
 *
 *     { "USD": "84210.00", "INR": "1980000.00" }
 *
 * Never a bare number, and never a total summed across currencies. The schema
 * has no FX rate anywhere in it, so adding USD to INR would be inventing an
 * exchange rate — silently, at report time, with no record of which rate. If
 * a converted total is ever wanted it needs a real FX service and an explicit
 * as-of date; until then the honest answer is one figure per currency.
 *
 * Values are strings because they come from Postgres `numeric` via Prisma's
 * Decimal. Passing them through JavaScript numbers would round 1980000.00 INR
 * at the edges of the float range and quietly corrupt a ledger figure.
 */

export type MoneyByCurrency = Partial<Record<Currency, string>>;

type DecimalLike = Prisma.Decimal | string | number | null | undefined;

function toDecimal(value: DecimalLike): Prisma.Decimal {
    if (value === null || value === undefined) return new Prisma.Decimal(0);
    return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** Accumulates `amount` rows grouped by currency into the response shape. */
export function sumByCurrency(
    rows: { currency: Currency; amount: DecimalLike }[],
): MoneyByCurrency {
    const totals = new Map<Currency, Prisma.Decimal>();
    for (const row of rows) {
        const current = totals.get(row.currency) ?? new Prisma.Decimal(0);
        totals.set(row.currency, current.plus(toDecimal(row.amount)));
    }
    return fromTotals(totals);
}

/** Adds several money maps together, per currency. */
export function addMoney(...maps: MoneyByCurrency[]): MoneyByCurrency {
    const totals = new Map<Currency, Prisma.Decimal>();
    for (const map of maps) {
        for (const [currency, value] of Object.entries(map) as [Currency, string][]) {
            const current = totals.get(currency) ?? new Prisma.Decimal(0);
            totals.set(currency, current.plus(new Prisma.Decimal(value)));
        }
    }
    return fromTotals(totals);
}

/**
 * `a - b` per currency. A currency present only in `b` yields a negative
 * figure rather than being dropped — a refund with no matching collection in
 * the window is real, and hiding it would make the books look balanced when
 * they are not.
 */
export function subtractMoney(a: MoneyByCurrency, b: MoneyByCurrency): MoneyByCurrency {
    const totals = new Map<Currency, Prisma.Decimal>();
    for (const [currency, value] of Object.entries(a) as [Currency, string][]) {
        totals.set(currency, new Prisma.Decimal(value));
    }
    for (const [currency, value] of Object.entries(b) as [Currency, string][]) {
        const current = totals.get(currency) ?? new Prisma.Decimal(0);
        totals.set(currency, current.minus(new Prisma.Decimal(value)));
    }
    return fromTotals(totals);
}

function fromTotals(totals: Map<Currency, Prisma.Decimal>): MoneyByCurrency {
    const out: MoneyByCurrency = {};
    for (const [currency, total] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
        out[currency] = total.toFixed(2);
    }
    return out;
}

/** One Decimal to the response's string form. */
export function money(value: DecimalLike): string {
    return toDecimal(value).toFixed(2);
}
