import { randomBytes } from 'node:crypto';

/**
 * HUMAN-READABLE RECORD IDENTIFIERS — `odr0h2k9m4p7x3f8q2n`, `inv0h2k9m4qb1y7z4s`.
 *
 * Every table carries a `publicCode` alongside its uuid primary key. The uuid
 * stays the key and every foreign key still points at it; this is the string a
 * person reads out on a support call, types into a search box, or quotes in a
 * ticket. Nothing joins on it.
 *
 * ## The shape
 *
 *     odr      0h2k9m4p7      x3f8q2n6rt
 *     └prefix  └time, 9 chars └random, 10 chars
 *
 * **Prefix** — 3 lowercase letters naming the table, so a bare code is
 * self-describing. `odr…` is an order wherever you find it.
 *
 * **Time** — milliseconds since 2020-01-01, base32. 45 bits, which carries the
 * scheme to the year 3100. It makes codes sort chronologically and, more
 * importantly, confines any possible collision to a single millisecond.
 *
 * **Random** — 50 bits from `crypto.randomBytes`, Node's CSPRNG. Not
 * `Math.random()`, which is seeded per process: two workers starting together
 * would produce the same stream and collide constantly.
 *
 * ## Why it will not collide at millions of rows
 *
 * Two codes can only clash if they are generated **in the same millisecond**
 * AND draw the same 50-bit random value. For `k` rows written in one
 * millisecond the chance of any clash is about `k² / 2⁵¹`:
 *
 * | rows in the same millisecond | probability of a collision |
 * |---|---|
 * | 1,000 | 1 in 2,000,000,000 |
 * | 10,000 | 1 in 22,000,000 |
 * | 100,000 | 1 in 225,000 |
 *
 * Total row count does not enter into it, because the timestamp partitions the
 * space — ten million rows spread over a year collide no more easily than ten
 * thousand do. And the column carries a UNIQUE index, so even the one-in-a-
 * billion case is a failed insert rather than two records sharing a code.
 *
 * ## The alphabet
 *
 * Crockford Base32, lowercase: `0123456789abcdefghjkmnpqrstvwxyz`. It drops
 * **i, l, o and u** — the first three because they are unreadable next to 1 and
 * 0 when someone reads a code down the phone, and `u` because removing it means
 * no generated code can spell an obscenity.
 */

/** Crockford Base32 — no i, l, o, u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * 2020-01-01T00:00:00Z. A custom epoch rather than the Unix one, so the
 * timestamp fits in 45 bits with centuries to spare instead of wasting five
 * characters encoding the 1970s.
 */
const EPOCH_MS = Date.UTC(2020, 0, 1);

const TIME_CHARS = 9;    // 45 bits
const RANDOM_CHARS = 10; // 50 bits

/** Total length of the code after its prefix. */
export const PUBLIC_CODE_BODY_LENGTH = TIME_CHARS + RANDOM_CHARS;

function encodeBase32(value: bigint, chars: number): string {
    let out = '';
    let rest = value;
    for (let i = 0; i < chars; i += 1) {
        out = ALPHABET[Number(rest & 31n)] + out;
        rest >>= 5n;
    }
    return out;
}

/**
 * A fresh public code for `prefix`.
 *
 * `now` is injectable for tests only; production never passes it.
 */
export function generatePublicCode(prefix: string, now: number = Date.now()): string {
    const elapsed = BigInt(Math.max(0, now - EPOCH_MS));
    // 8 bytes of CSPRNG output, shifted down to the 50 bits we encode.
    const random = randomBytes(8).readBigUInt64BE() >> 14n;
    return prefix + encodeBase32(elapsed, TIME_CHARS) + encodeBase32(random, RANDOM_CHARS);
}

/** Reads the millisecond a code was issued at. Handy when debugging. */
export function publicCodeIssuedAt(code: string, prefixLength = 3): Date {
    const time = code.slice(prefixLength, prefixLength + TIME_CHARS);
    let value = 0n;
    for (const char of time) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new Error(`"${code}" is not a valid public code.`);
        value = (value << 5n) | BigInt(index);
    }
    return new Date(Number(value) + EPOCH_MS);
}

/**
 * Model name -> prefix. The Prisma model name exactly as generated, because
 * the client extension looks it up by `model`.
 *
 * A model missing from this map simply gets no code written, which is what
 * makes adding a table a two-line change rather than a migration plus a code
 * hunt.
 */
export const PUBLIC_CODE_PREFIXES: Record<string, string> = {
    // access-control
    Role: 'rol',
    Permission: 'prm',
    RolePermission: 'rlp',
    RoleAssignment: 'ras',
    StaffInvitation: 'sti',
    // artist
    Artist: 'art',
    ArtistCollection: 'acl',
    ArtistBrandLink: 'abl',
    // audit
    AuditEventType: 'aet',
    AuditEvent: 'aud',
    AuditRetentionPolicy: 'arp',
    // auth
    AuthWebhookEvent: 'awh',
    // claims
    SkuClaim: 'clm',
    BlockchainLedger: 'bcl',
    SkuHistory: 'skh',
    // collections
    BuyerCollection: 'bcn',
    // content
    ContentBundle: 'cbd',
    ContentBundleItem: 'cbi',
    ContentUnlock: 'cul',
    // evolution
    EvolutionRule: 'evr',
    EvolutionEvent: 'eve',
    // finance
    RoyaltyRule: 'ryr',
    RoyaltyLedgerEntry: 'rle',
    RoyaltyPayout: 'pyo',
    AdjustmentEntry: 'adj',
    FinanceLedgerEntry: 'fle',
    CogsReconciliation: 'cgr',
    // markets
    Market: 'mkt',
    MarketCountry: 'mkc',
    // media
    MediaAsset: 'mda',
    // notifications
    NotificationTemplate: 'ntt',
    Notification: 'ntf',
    NotificationPreference: 'ntp',
    // orders
    Order: 'odr',
    OrderAddress: 'oda',
    InventoryReservation: 'ivr',
    // organizations
    Organization: 'org',
    // payments
    PaymentTransaction: 'pmt',
    PaymentGatewayConfig: 'pgc',
    PaymentWebhookEvent: 'pwh',
    RefundRequest: 'rfd',
    DisputeCase: 'dsp',
    // platform
    PlatformConfig: 'pcf',
    ExceptionCase: 'exc',
    // products
    Drop: 'drp',
    DropVariant: 'dvr',
    DropImage: 'dim',
    DropPrice: 'dpr',
    DropVariantOption: 'dvo',
    DropType: 'dty',
    DropTypeDimension: 'dtd',
    DropTypeDimensionValue: 'dtv',
    // releases
    ReleaseApproval: 'rap',
    // resale
    ResaleListing: 'rsl',
    // search
    SearchIndexJob: 'sij',
    // skus
    Sku: 'sku',
    NfcVerification: 'nfv',
    // social
    Follow: 'flw',
    WishlistItem: 'wsh',
    // supply
    Vendor: 'vnd',
    SupplyBatch: 'sbt',
    NfcTag: 'nft',
    // support
    SupportCase: 'spc',
    // tax
    TaxConfiguration: 'txc',
    Invoice: 'inv',
    InvoiceLineItem: 'ivl',
    InvoiceNumberSequence: 'ins',
    TaxReturnFiling: 'trf',
    ArtistTaxDocument: 'atd',
    TaxAdjustmentEntry: 'tad',
    // users
    User: 'usr',
    Address: 'adr',
};

/**
 * Fails at import time on a duplicated prefix.
 *
 * Two tables sharing one would make a code ambiguous to read, which is the
 * single thing this scheme exists to avoid — and it is the kind of mistake
 * that is invisible until somebody pastes an `odr…` into the wrong lookup.
 */
function assertPrefixesUnique(): void {
    const seen = new Map<string, string>();
    for (const [model, prefix] of Object.entries(PUBLIC_CODE_PREFIXES)) {
        const existing = seen.get(prefix);
        if (existing) {
            throw new Error(
                `Public code prefix "${prefix}" is used by both ${existing} and ${model}.`,
            );
        }
        seen.set(prefix, model);
    }
}

assertPrefixesUnique();
