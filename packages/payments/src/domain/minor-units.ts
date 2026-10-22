/**
 * Money in the provider's smallest unit. Used by the Stripe adapter to send
 * amounts, and by the refund webhook to compare a dashboard refund's amount
 * with the approved request.
 */

/** Currencies Stripe takes in whole units. None of HitBox's markets today; here so adding one is not a 100× bug. */
const ZERO_DECIMAL = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
    'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * "2499.00" → 249900. Done on the string, never through a float: 0.29 * 100
 * is 28.999999999999996.
 */
export function toMinorUnits(amount: string, currency: string): number {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
    if (!match) throw new Error(`Not a money amount: "${amount}"`);
    const whole = match[1]!;
    const fraction = (match[2] ?? '').padEnd(2, '0');
    if (ZERO_DECIMAL.has(currency.toUpperCase())) {
        if (fraction !== '00') throw new Error(`${currency} has no minor unit: "${amount}"`);
        return Number(whole);
    }
    return Number(whole) * 100 + Number(fraction);
}
