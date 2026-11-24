/**
 * Regional rules for an address: which postal codes and states are real.
 *
 * Strict for the two countries HitBox taxes (IN and US, the tax module's
 * jurisdictions) because the billing address's country and *state* pick the
 * tax rate on the invoice: a state typed as "Karnataka" instead of "KA", or a
 * ZIP with a typo, silently selects the wrong rate or none. Every other
 * country gets a loose check (shape only), since HitBox ships there but has
 * no rule that depends on the value.
 */

/** ISO 3166-2:IN: 28 states and 8 union territories. */
export const IN_STATE_CODES: ReadonlySet<string> = new Set(
    'AN AP AR AS BR CH CG DD DL GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD PB PY RJ SK TN TR TS UK UP WB'.split(' '),
);

/** 50 states, DC, and the inhabited territories that use USPS ZIP codes. */
export const US_STATE_CODES: ReadonlySet<string> = new Set(
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP'.split(' '),
);

/** ISO 3166-1 alpha-2 (officially assigned codes). */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '),
);

const IN_POSTAL = /^[1-9][0-9]{5}$/;
const US_POSTAL = /^[0-9]{5}(-[0-9]{4})?$/;
/** Anywhere else: 2-12 letters, digits, spaces or hyphens, starting alphanumeric. */
const LOOSE_POSTAL = /^[A-Z0-9][A-Z0-9 -]{1,11}$/;

export interface RegionIssue {
    path: 'state' | 'postalCode' | 'countryCode';
    message: string;
}

/**
 * The canonical stored form: IN postal codes lose their inner space
 * ("560 001" becomes "560001"), everything else is trimmed and collapsed;
 * loose postal codes are upper-cased.
 */
export function normalizePostalCode(countryCode: string, postalCode: string): string {
    const collapsed = postalCode.trim().replace(/\s+/g, ' ');
    if (countryCode === 'IN') return collapsed.replace(/ /g, '');
    return countryCode === 'US' ? collapsed : collapsed.toUpperCase();
}

/** Checks country, state and postal code together. Inputs are already normalized. */
export function validateRegion(input: {
    countryCode: string;
    state: string | null;
    postalCode: string;
}): RegionIssue[] {
    const issues: RegionIssue[] = [];
    const { countryCode, state, postalCode } = input;

    if (!ISO_COUNTRY_CODES.has(countryCode)) {
        issues.push({ path: 'countryCode', message: 'Must be an ISO 3166-1 alpha-2 country code, e.g. "IN".' });
        return issues;
    }

    if (countryCode === 'IN') {
        if (!IN_POSTAL.test(postalCode)) {
            issues.push({ path: 'postalCode', message: 'An Indian PIN code is 6 digits and does not start with 0, e.g. "560001".' });
        }
        if (!state || !IN_STATE_CODES.has(state)) {
            issues.push({ path: 'state', message: 'An Indian address needs its ISO state or union-territory code, e.g. "KA".' });
        }
    } else if (countryCode === 'US') {
        if (!US_POSTAL.test(postalCode)) {
            issues.push({ path: 'postalCode', message: 'A US ZIP code is 5 digits, optionally +4, e.g. "78701" or "78701-1234".' });
        }
        if (!state || !US_STATE_CODES.has(state)) {
            issues.push({ path: 'state', message: 'A US address needs its 2-letter state code, e.g. "TX".' });
        }
    } else if (!LOOSE_POSTAL.test(postalCode)) {
        issues.push({ path: 'postalCode', message: 'Must be 2-12 letters, digits, spaces or hyphens.' });
    }
    return issues;
}
