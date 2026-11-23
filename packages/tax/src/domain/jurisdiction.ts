/**
 * Which country's tax rules apply to a sale.
 *
 * The billing address decides. With none, the settlement currency is the
 * fallback (INR → IN, anything else → US), which is a guess: a GBP buyer with
 * no billing address is taxed as American. That guess is why checkout asks for a
 * billing address whenever the fallback country would charge tax.
 *
 * One function, used by the invoice and by the checkout quote, so both resolve
 * the same country for the same inputs.
 */
export function jurisdictionFor(countryCode: string | null | undefined, currency: string): string {
    if (countryCode) return countryCode.toUpperCase();
    return currency === 'INR' ? 'IN' : 'US';
}
