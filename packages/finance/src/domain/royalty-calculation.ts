import { Prisma } from '@hitbox/database';
import type { RoyaltyBasis } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { FINANCE_ERROR_CODES } from '../constants/finance.constant';

/**
 * The arithmetic, on its own, with no database and no Express in sight.
 *
 * The design document states it in one line —
 *
 *     Royalty Amount = Net Profit × Artist Royalty %
 *     Net Profit     = Gross Revenue − COGS
 *     $100 gross, $25 COGS, 15%  →  $75 × 0.15 = $11.25
 *
 * — and that is exactly what `calculateRoyalty` does. It lives here rather than
 * inside the accrual service so the unit test can assert the worked example
 * from the document against the real code path, and so the GROSS_REVENUE basis
 * is visibly the same function with one term dropped rather than a second
 * implementation that can drift.
 *
 * Everything is `Prisma.Decimal`. Money in this codebase never touches a
 * JavaScript number: 0.1 + 0.2 is not 0.3, and a ledger that is append-only
 * cannot quietly fix a rounding error later.
 */

export interface RoyaltyCalculationInput {
    /** What the buyer paid, for the units this accrual covers. */
    grossRevenue: Prisma.Decimal;
    /** Manufacturing + authentication + tag. Null is treated as zero. */
    costOfGoods: Prisma.Decimal | null;
    /** NET_PROFIT (gross − cogs) or GROSS_REVENUE (cogs ignored). */
    basis: RoyaltyBasis;
    /** 15 means 15%, not 0.15. Matches how a deal is written down. */
    percentage: Prisma.Decimal;
}

export interface RoyaltyCalculation {
    grossRevenue: Prisma.Decimal;
    costOfGoods: Prisma.Decimal;
    /** gross − cogs, floored at zero — see below. */
    netProfit: Prisma.Decimal;
    /** What the percentage was actually applied to. */
    base: Prisma.Decimal;
    percentage: Prisma.Decimal;
    /** The posted figure, rounded half-up to 2 dp. */
    amount: Prisma.Decimal;
}

/** Money is stored as DECIMAL(12,2); every posted figure is rounded to match. */
export function toMoney(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function calculateRoyalty(input: RoyaltyCalculationInput): RoyaltyCalculation {
    if (input.percentage.lessThan(0) || input.percentage.greaterThan(100)) {
        throw AppError.badRequest(
            'A royalty percentage must be between 0 and 100.',
            FINANCE_ERROR_CODES.INVALID_RULE,
            { percentage: input.percentage.toString() },
        );
    }

    const costOfGoods = input.costOfGoods ?? new Prisma.Decimal(0);
    const rawNet = input.grossRevenue.minus(costOfGoods);

    // A sale below cost owes the artist nothing rather than owing HitBox
    // money back: a negative accrual would net against unrelated sales and
    // silently reduce a payout the artist has already been told about. If the
    // platform ever wants to claw that back, it is an AdjustmentEntry with a
    // reason on it — a decision someone makes, not a side effect of arithmetic.
    const netProfit = rawNet.isNegative() ? new Prisma.Decimal(0) : rawNet;

    const base = input.basis === 'GROSS_REVENUE' ? input.grossRevenue : netProfit;
    const amount = toMoney(base.times(input.percentage).dividedBy(100));

    return {
        grossRevenue: toMoney(input.grossRevenue),
        costOfGoods: toMoney(costOfGoods),
        netProfit: toMoney(netProfit),
        base: toMoney(base),
        percentage: input.percentage,
        amount,
    };
}

// ── Rule resolution ─────────────────────────────────────────────────────────

/** The four scope columns a rule may be pinned to, most specific first. */
export const RULE_SCOPE_ORDER = [
    'productId',
    'collectionId',
    'artistId',
    'organizationId',
] as const;
export type RuleScopeColumn = (typeof RULE_SCOPE_ORDER)[number];

export interface ScopedRule {
    id: string;
    productId: string | null;
    collectionId: string | null;
    artistId: string | null;
    organizationId: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
}

/**
 * Which rule applies to one sale, given every rule that could.
 *
 * Most-specific-first: a rule pinned to the product beats one pinned to the
 * collection, which beats the artist's default, which beats the organization's.
 * Among equally specific rules the latest `effectiveFrom` wins, which is what
 * makes "renegotiated on 1 March" work without deleting the old row — and what
 * makes re-running a February order reproduce February's number.
 *
 * `at` is the moment the accrual is *for* (the claim), not now.
 */
export function resolveRule<T extends ScopedRule>(rules: readonly T[], at: Date): T | null {
    const applicable = rules.filter(
        (rule) =>
            rule.effectiveFrom.getTime() <= at.getTime() &&
            (rule.effectiveTo === null || rule.effectiveTo.getTime() > at.getTime()),
    );
    if (applicable.length === 0) return null;

    for (const column of RULE_SCOPE_ORDER) {
        const atThisScope = applicable.filter((rule) => rule[column] !== null);
        if (atThisScope.length === 0) continue;
        return atThisScope.reduce((best, rule) =>
            rule.effectiveFrom.getTime() > best.effectiveFrom.getTime() ? rule : best,
        );
    }

    // A rule with all four scope columns null is the platform-wide default.
    return applicable.reduce((best, rule) =>
        rule.effectiveFrom.getTime() > best.effectiveFrom.getTime() ? rule : best,
    );
}

// ── Split configuration ─────────────────────────────────────────────────────

/**
 * One payee's share of a rule. `splitConfig` carries an array of these for a
 * multi-party deal (artist 10% / brand 5%); the single-payee case is the
 * `percentage` column and is normalised into the same shape by
 * `splitsOf`, so the accrual service has exactly one code path.
 */
export interface RoyaltySplit {
    payeeType: 'ARTIST' | 'ORGANIZATION';
    artistId: string | null;
    organizationId: string | null;
    percentage: Prisma.Decimal;
}

export interface SplitSource {
    percentage: Prisma.Decimal | null;
    splitConfig: Prisma.JsonValue;
    artistId: string | null;
    organizationId: string | null;
}

/**
 * The payees of one rule.
 *
 * Shape accepted in `splitConfig`:
 *
 *     { "splits": [ { "payeeType": "ARTIST", "artistId": "…", "percentage": 10 },
 *                   { "payeeType": "ORGANIZATION", "organizationId": "…", "percentage": 5 } ] }
 *
 * Anything else — `{}`, null, an empty array — falls back to the `percentage`
 * column paid to whichever party the rule is scoped to. That fallback is the
 * common case, not an error path: most deals are one artist and one number.
 */
export function splitsOf(rule: SplitSource, fallbackArtistId: string | null): RoyaltySplit[] {
    const config = rule.splitConfig as { splits?: unknown } | null;
    const raw = Array.isArray(config?.splits) ? config.splits : [];

    const splits: RoyaltySplit[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const item = entry as Record<string, unknown>;
        const percentage = item.percentage;
        if (typeof percentage !== 'number' && typeof percentage !== 'string') continue;

        const payeeType = item.payeeType === 'ORGANIZATION' ? 'ORGANIZATION' : 'ARTIST';
        const artistId = typeof item.artistId === 'string' ? item.artistId : null;
        const organizationId =
            typeof item.organizationId === 'string' ? item.organizationId : null;

        // A split that names no payee cannot be paid to anyone. Skipping it
        // rather than defaulting it keeps a malformed config from quietly
        // paying the wrong party.
        if (payeeType === 'ARTIST' && !artistId) continue;
        if (payeeType === 'ORGANIZATION' && !organizationId) continue;

        splits.push({
            payeeType,
            artistId,
            organizationId,
            percentage: new Prisma.Decimal(percentage),
        });
    }

    if (splits.length > 0) return splits;

    if (rule.percentage === null) {
        throw AppError.badRequest(
            'This royalty rule has neither a percentage nor a usable split configuration.',
            FINANCE_ERROR_CODES.INVALID_RULE,
        );
    }

    // Single-payee fallback: the rule's own scope decides who is paid. An
    // organization-scoped rule with no artist behind it pays the organization.
    const artistId = rule.artistId ?? fallbackArtistId;
    if (artistId) {
        return [
            {
                payeeType: 'ARTIST',
                artistId,
                organizationId: null,
                percentage: rule.percentage,
            },
        ];
    }
    if (rule.organizationId) {
        return [
            {
                payeeType: 'ORGANIZATION',
                artistId: null,
                organizationId: rule.organizationId,
                percentage: rule.percentage,
            },
        ];
    }

    throw AppError.badRequest(
        'This royalty rule names no payee — it has no artist, organization or split configuration.',
        FINANCE_ERROR_CODES.INVALID_RULE,
    );
}

// ── Idempotency keys ────────────────────────────────────────────────────────

/**
 * One accrual per (claim, rule, payee). This string is a UNIQUE column, which
 * is the whole of the duplicate-accrual defence: a replayed claim event, a
 * retried job and a manual re-run all collide on it and the second write is a
 * no-op rather than a second credit.
 */
export function accrualKeyFor(claimId: string, ruleId: string, payeeId: string): string {
    return `claim:${claimId}:rule:${ruleId}:payee:${payeeId}`;
}

/** One reversal per entry, for the same reason. */
export function reversalKeyFor(entryId: string): string {
    return `reversal:${entryId}`;
}
