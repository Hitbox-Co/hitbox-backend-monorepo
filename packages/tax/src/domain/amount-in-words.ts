/**
 * The invoice total, spelled out.
 *
 * Conventional on an Indian tax invoice and a real control everywhere: a
 * transposed digit in `24,20.00` is invisible, and "Rupees Two Thousand Two
 * Hundred Forty Only" is not. Printed under the totals block by the renderer.
 *
 * Two numbering systems, because they genuinely differ:
 *
 *   **INR** uses the Indian system — thousand, lakh (10^5), crore (10^7) — and
 *   the fractional unit is paise. "Twelve Lakh Thirty-Four Thousand" is how an
 *   Indian invoice reads; "One Point Two Million" is not.
 *
 *   **Everything else** uses the short scale — thousand, million, billion —
 *   with cents.
 */

const ONES = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = [
    '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

const UNITS: Record<string, { major: string; minor: string }> = {
    INR: { major: 'Rupees', minor: 'Paise' },
    USD: { major: 'Dollars', minor: 'Cents' },
    GBP: { major: 'Pounds', minor: 'Pence' },
};

/** 0–999 in words. */
function underThousand(value: number): string {
    if (value === 0) return '';
    if (value < 20) return ONES[value] as string;
    if (value < 100) {
        const tens = TENS[Math.floor(value / 10)] as string;
        const ones = ONES[value % 10] as string;
        return ones ? `${tens}-${ones}` : tens;
    }
    const hundreds = `${ONES[Math.floor(value / 100)]} Hundred`;
    const rest = underThousand(value % 100);
    return rest ? `${hundreds} ${rest}` : hundreds;
}

/** Indian system: crore, lakh, thousand, hundred. */
function indianWords(value: number): string {
    if (value === 0) return 'Zero';
    const parts: string[] = [];
    const crore = Math.floor(value / 10_000_000);
    const lakh = Math.floor((value % 10_000_000) / 100_000);
    const thousand = Math.floor((value % 100_000) / 1000);
    const rest = value % 1000;

    if (crore > 0) parts.push(`${indianWords(crore)} Crore`);
    if (lakh > 0) parts.push(`${underThousand(lakh)} Lakh`);
    if (thousand > 0) parts.push(`${underThousand(thousand)} Thousand`);
    if (rest > 0) parts.push(underThousand(rest));
    return parts.join(' ');
}

/** Short scale: billion, million, thousand. */
function shortScaleWords(value: number): string {
    if (value === 0) return 'Zero';
    const parts: string[] = [];
    const scales: [number, string][] = [
        [1_000_000_000, 'Billion'],
        [1_000_000, 'Million'],
        [1000, 'Thousand'],
    ];
    let remaining = value;
    for (const [size, name] of scales) {
        const count = Math.floor(remaining / size);
        if (count > 0) {
            parts.push(`${shortScaleWords(count)} ${name}`);
            remaining %= size;
        }
    }
    if (remaining > 0) parts.push(underThousand(remaining));
    return parts.join(' ');
}

/**
 * `'2240.00', 'INR'` -> `'Rupees Two Thousand Two Hundred Forty Only'`.
 *
 * Takes the amount as a **string**, the same decimal string the invoice row
 * stores, so there is no float anywhere between the stored total and the words
 * printed beside it.
 */
export function amountInWords(amount: string, currency: string): string {
    const negative = amount.startsWith('-');
    const [wholeText = '0', fractionText = ''] = (negative ? amount.slice(1) : amount).split('.');
    const whole = Number(wholeText);
    const minor = Number(fractionText.padEnd(2, '0').slice(0, 2)) || 0;

    if (!Number.isSafeInteger(whole)) {
        // Far beyond any plausible invoice; better to print the figure than a
        // wrong or truncated spelling.
        return `${currency} ${amount}`;
    }

    const unit = UNITS[currency] ?? { major: currency, minor: 'Cents' };
    const words = currency === 'INR' ? indianWords(whole) : shortScaleWords(whole);

    const majorPart = `${unit.major} ${words}`;
    const minorPart = minor > 0 ? ` and ${underThousand(minor)} ${unit.minor}` : '';
    return `${negative ? 'Minus ' : ''}${majorPart}${minorPart} Only`;
}
