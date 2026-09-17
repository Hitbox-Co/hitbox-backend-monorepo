/**
 * Decimal arithmetic for tax, done on strings.
 *
 * Every money and rate column in this module is a Prisma `Decimal`, and tax is
 * the one place in the system where a rounding error is not a rounding error
 * but a wrong number on a government filing. So nothing here goes through
 * `number`: amounts are scaled integers internally (minor units × 10^4 while
 * multiplying), and the only conversion to a fixed scale is one explicit,
 * half-up rounding step at the end.
 *
 * Half-up rather than banker's rounding because that is what both regimes
 * expect on an invoice: CGST/SGST rounding under Indian GST rules and US state
 * sales tax are both "round half away from zero" at the invoice level.
 */

const SCALE = 6;

/** Parses "12.00", "-3.5", "1234" into a bigint scaled by 10^SCALE. */
function parse(value: string | number): bigint {
    const text = typeof value === 'number' ? value.toString() : value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new Error(`Not a decimal value: "${text}"`);
    }
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const padded = (fraction + '0'.repeat(SCALE)).slice(0, SCALE);
    const magnitude = BigInt(whole + padded);
    return negative ? -magnitude : magnitude;
}

/** Renders a scaled bigint at `places` decimals, rounding half away from zero. */
function format(scaled: bigint, places: number): string {
    const negative = scaled < 0n;
    let magnitude = negative ? -scaled : scaled;

    const drop = SCALE - places;
    if (drop > 0) {
        const divisor = 10n ** BigInt(drop);
        const remainder = magnitude % divisor;
        magnitude /= divisor;
        // Half away from zero: the remainder is compared against half the
        // divisor, so .5 always rounds up in magnitude.
        if (remainder * 2n >= divisor) magnitude += 1n;
    }

    const unit = 10n ** BigInt(places);
    const whole = magnitude / unit;
    const fraction = magnitude % unit;
    const text =
        places === 0
            ? whole.toString()
            : `${whole}.${fraction.toString().padStart(places, '0')}`;
    return negative && magnitude !== 0n ? `-${text}` : text;
}

/** A money string at 2 decimal places — the scale of every Decimal(12,2). */
export function money(value: string | number): string {
    return format(parse(value), 2);
}

/** `a × b`, rounded to 2 places. */
export function multiplyMoney(a: string | number, b: string | number): string {
    const product = (parse(a) * parse(b)) / 10n ** BigInt(SCALE);
    return format(product, 2);
}

/** `a + b` at 2 places. */
export function addMoney(a: string | number, b: string | number): string {
    return format(parse(a) + parse(b), 2);
}

/** `a − b` at 2 places. */
export function subtractMoney(a: string | number, b: string | number): string {
    return format(parse(a) - parse(b), 2);
}

/** Sums a list at 2 places. An empty list is "0.00", not an error. */
export function sumMoney(values: (string | number)[]): string {
    return format(
        values.reduce<bigint>((total, value) => total + parse(value), 0n),
        2,
    );
}

/**
 * Tax on an amount at a percentage rate.
 *
 * `amount × rate / 100`, rounded half-up to 2 places — the arithmetic the
 * compliance guide states in §1.1 (₹2,000 × 12% = ₹240) and §2.1
 * ($25 × 8.625% = $2.16, where the exact product is 2.15625 and the half-up
 * step is what produces the figure the guide prints).
 */
export function taxOn(amount: string | number, ratePercent: string | number): string {
    // One truncation, at 10^-6 of the result — six orders of magnitude below
    // the 2-decimal scale the invoice is written at, so the half-up step in
    // `format` is what actually decides the last digit.
    const scaled = (parse(amount) * parse(ratePercent)) / (100n * 10n ** BigInt(SCALE));
    return format(scaled, 2);
}

/** `a` compared to `b`: -1, 0 or 1. */
export function compareMoney(a: string | number, b: string | number): number {
    const left = parse(a);
    const right = parse(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A rate string at 3 places, matching `Decimal(6,3)`.
 *
 * Three, not two, because US combined sales-tax rates routinely carry a third
 * decimal — California's 8.625%, New York City's 8.875% — and a rate rounded
 * to 8.63% is a figure that appears in no state rate table and cannot be
 * reconciled against one. India's GST rates are whole percentages and simply
 * carry two trailing zeros.
 */
export function rate(value: string | number): string {
    return format(parse(value), 3);
}
