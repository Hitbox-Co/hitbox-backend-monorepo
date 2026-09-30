/**
 * Finance + payout demo data, derived from the artists, drops, orders and
 * claims that are already in the database.
 *
 *   pnpm db:seed:finance     — rebuild just the finance tables
 *   pnpm db:seed:demo        — runs this at the end, on the data it just made
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * The finance block that used to live inline in `seed-demo.ts` produced rows
 * that were the right *shape* and the wrong *content*, which is the worst kind
 * of demo data: every screen renders, every number is a lie, and nothing fails
 * loudly enough to notice. Specifically, every royalty entry it wrote had
 *
 *   - `payeeArtistId` and `payeeOrganizationId` both null, so not one penny in
 *     the ledger was attributable to an artist and `RoyaltyBalanceView` folded
 *     all three artists into a single anonymous `payeeId: null` bucket;
 *   - `basis: NET_PROFIT` on entries whose rule said `GROSS_REVENUE`;
 *   - null `percentage` / `grossRevenue` / `costOfGoods` / `netProfit`, so the
 *     "an entry carries its own arithmetic" guarantee — the thing that lets an
 *     accrual be re-checked years later — held no arithmetic at all;
 *   - `accrualKey` set to the row's own uuid rather than
 *     `claim:…:rule:…:payee:…`, so the unique index guarded nothing;
 *   - `skuId` and `claimId` null, severing the ledger from the claim that is
 *     supposed to have triggered it.
 *
 * ── The one rule this file follows ──────────────────────────────────────────
 *
 * **The numbers are computed by the same code the API runs.** `calculateRoyalty`,
 * `resolveRule`, `splitsOf`, `accrualKeyFor` and `reversalKeyFor` are imported
 * from `@hitbox/finance`, not reimplemented here. A fixture that recomputes a
 * formula by hand is a fixture that drifts from the formula, and a royalty
 * demo that disagrees with the royalty engine is worse than no demo.
 *
 * That is also why `@hitbox/database` depends on `@hitbox/finance`: exactly the
 * arrangement already in place for `@hitbox/audit` and `@hitbox/access-control`,
 * whose seeds likewise read their module's own source of truth.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 *
 *   RoyaltyRule          5 — versioned, multi-party and drop-scoped deals
 *   RoyaltyLedgerEntry   one per (claim, rule, payee), accrued at claim time
 *   RoyaltyPayout        batches across all five lifecycle states
 *   AdjustmentEntry      refund reversals, a clawback, and manual corrections
 *   FinanceLedgerEntry   all six postings per order, plus the payout cash leg
 *
 * Ids are deterministic (same `id()` derivation as `seed-demo.ts`), so re-running
 * reproduces the same rows and a bug report stays valid across runs.
 */
import { createHash } from 'node:crypto';
import {
    AdjustmentReason, AdjustmentStatus, AdjustmentTargetType, Currency,
    FinanceCategory, FinanceDirection, LedgerEntryType, PayoutFrequency,
    PayoutStatus, Prisma, RoyaltyBasis, RoyaltyEntryStatus, RoyaltyPayeeType,
} from '@prisma/client';
import {
    accrualKeyFor, calculateRoyalty, resolveRule, reversalKeyFor, splitsOf,
} from '@hitbox/finance';
import { prisma } from '../src/index';

// ── Shared helpers (kept byte-identical to seed-demo.ts on purpose) ─────────

/** A stable UUIDv4-shaped id derived from a label. */
function id(label: string): string {
    const h = createHash('sha1').update(`hitbox-demo:${label}`).digest('hex');
    return [
        h.slice(0, 8), h.slice(8, 12),
        `4${h.slice(13, 16)}`,
        ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
        h.slice(20, 32),
    ].join('-');
}

const NOW = new Date();
function daysAgo(days: number, hour = 12): Date {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - days);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
}
function dec(value: string | number | Prisma.Decimal): Prisma.Decimal {
    return new Prisma.Decimal(value);
}
const ZERO = new Prisma.Decimal(0);

/** First day of the month containing `at`, as a DATE column wants it. */
function monthStart(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
/** Last day of the month containing `at`. */
function monthEnd(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0));
}

/**
 * The gateway's cut: Stripe's standard 2.9% + 30c, in the order's own currency.
 * INR is quoted in whole rupees here rather than converting, which is what the
 * rest of the demo data does and keeps the arithmetic checkable by eye.
 */
function gatewayFee(amount: Prisma.Decimal, currency: Currency): Prisma.Decimal {
    const fixed = currency === Currency.INR ? 3 : 0.3;
    return amount.times('0.029').plus(fixed).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// ── The deals ───────────────────────────────────────────────────────────────

/**
 * Five rules covering the four shapes the resolver has to get right, written
 * as the deals they represent rather than as test fixtures.
 *
 * `payoutThreshold` is a single Decimal with no currency on it, which means one
 * threshold governs a payee's GBP, USD and INR balances alike — 50 reads as
 * "$50" against a USD balance and "₹50" against an INR one, which are not the
 * same amount of money. That is a real limitation of the schema rather than an
 * accident of this data, and it is why every INR balance here sweeps on the
 * first attempt while the USD and GBP balances take months to clear the same
 * number. Worth fixing before a payee is ever paid in two currencies at once.
 */
interface DealSpec {
    key: string;
    artistSlug: string;
    /** Scope the rule to one drop, by its position in that artist's catalog. */
    dropIndex?: number;
    basis: RoyaltyBasis;
    splitType: string;
    /** Multi-party deal, in the shape `splitsOf` actually reads. */
    splits?: { payeeType: 'ARTIST' | 'ORGANIZATION'; percentage: number }[];
    /** Single-payee deal: the `percentage` column, paid to the rule's scope. */
    percentage?: number;
    payoutThreshold: number | null;
    payoutFrequency: PayoutFrequency | null;
    effectiveFromDays: number;
    effectiveToDays: number | null;
}

const DEALS: DealSpec[] = [
    // Ronin is brand-managed, so the label takes a cut alongside the artist.
    // This is the only deal that uses `splitConfig.splits`, and it is the
    // reason the ledger has ORGANIZATION payees in it at all.
    //
    // The original terms, superseded when the deal was renegotiated. Kept
    // rather than deleted: re-running a July order has to reproduce July's
    // number, which is exactly what `effectiveTo` buys.
    {
        key: 'ronin-2025',
        artistSlug: 'ronin',
        basis: RoyaltyBasis.NET_PROFIT,
        splitType: 'split',
        splits: [
            { payeeType: 'ARTIST', percentage: 15 },
            { payeeType: 'ORGANIZATION', percentage: 6 },
        ],
        payoutThreshold: 50,
        payoutFrequency: PayoutFrequency.MONTHLY,
        effectiveFromDays: 180,
        effectiveToDays: 75,
    },
    {
        key: 'ronin-current',
        artistSlug: 'ronin',
        basis: RoyaltyBasis.NET_PROFIT,
        splitType: 'split',
        splits: [
            { payeeType: 'ARTIST', percentage: 18 },
            { payeeType: 'ORGANIZATION', percentage: 7 },
        ],
        payoutThreshold: 50,
        payoutFrequency: PayoutFrequency.MONTHLY,
        effectiveFromDays: 75,
        effectiveToDays: null,
    },
    // Lumen's deal is on gross, which is worth having in the data because the
    // COGS column then demonstrably does not affect the payout.
    {
        key: 'lumen',
        artistSlug: 'lumen',
        basis: RoyaltyBasis.GROSS_REVENUE,
        splitType: 'percentage',
        percentage: 22,
        payoutThreshold: 50,
        payoutFrequency: PayoutFrequency.MONTHLY,
        effectiveFromDays: 180,
        effectiveToDays: null,
    },
    // Kaze self-releases, so the rate is far higher and the sweep far slower.
    {
        key: 'kaze',
        artistSlug: 'kaze',
        basis: RoyaltyBasis.NET_PROFIT,
        splitType: 'percentage',
        percentage: 35,
        payoutThreshold: 75,
        payoutFrequency: PayoutFrequency.QUARTERLY,
        effectiveFromDays: 180,
        effectiveToDays: null,
    },
    // A one-drop collaboration on better terms. Drop-scoped, so it must beat
    // the artist-scoped rule above for that drop and only that drop — the
    // most-specific-first branch of `resolveRule`, exercised by real data.
    {
        key: 'kaze-collab',
        artistSlug: 'kaze',
        dropIndex: 0,
        basis: RoyaltyBasis.GROSS_REVENUE,
        splitType: 'percentage',
        percentage: 45,
        payoutThreshold: null,
        payoutFrequency: null,
        effectiveFromDays: 180,
        effectiveToDays: null,
    },
];

// ── Types for the rows we read back out of the database ────────────────────

interface RuleRow {
    id: string;
    productId: string | null;
    collectionId: string | null;
    artistId: string | null;
    organizationId: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    basis: RoyaltyBasis;
    percentage: Prisma.Decimal | null;
    splitConfig: Prisma.JsonValue;
}

interface PlannedEntry {
    id: string;
    orderId: string;
    ruleId: string;
    skuId: string;
    claimId: string;
    accrualKey: string;
    payeeType: RoyaltyPayeeType;
    payeeArtistId: string | null;
    payeeOrganizationId: string | null;
    payeeKey: string;
    basis: RoyaltyBasis;
    percentage: Prisma.Decimal;
    grossRevenue: Prisma.Decimal;
    costOfGoods: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    amount: Prisma.Decimal;
    currency: Currency;
    entryType: LedgerEntryType;
    status: RoyaltyEntryStatus;
    adjustsEntryId: string | null;
    payoutId: string | null;
    accruedAt: Date;
    paidAt: Date | null;
    createdAt: Date;
    provenanceLedgerId: string | null;
}

export interface FinanceSeedSummary {
    rules: number;
    entries: number;
    payouts: number;
    adjustments: number;
    financeEntries: number;
    ordersLinkedToClaims: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  The seed
// ═══════════════════════════════════════════════════════════════════════════

export async function seedFinanceDemo(): Promise<FinanceSeedSummary> {
    // ── Clear, in foreign-key order ─────────────────────────────────────────
    // Entries point at both payouts and rules, so they go first. Adjustments
    // and platform-ledger lines carry no FK to any of it.
    await prisma.royaltyLedgerEntry.deleteMany();
    await prisma.royaltyPayout.deleteMany();
    await prisma.royaltyRule.deleteMany();
    await prisma.adjustmentEntry.deleteMany();
    await prisma.financeLedgerEntry.deleteMany();

    // ── Read the world ──────────────────────────────────────────────────────
    const artists = await prisma.artist.findMany({
        select: { id: true, slug: true, name: true, organizationId: true },
    });
    const artistBySlug = new Map(artists.map((a) => [a.slug, a]));

    const drops = await prisma.drop.findMany({
        select: { id: true, name: true, artistId: true, organizationId: true, collectionId: true },
        orderBy: { createdAt: 'asc' },
    });
    const dropById = new Map(drops.map((d) => [d.id, d]));

    const prices = await prisma.dropPrice.findMany({
        select: { dropId: true, marketId: true, costOfGoods: true, amount: true },
    });
    const cogsPerUnit = new Map<string, Prisma.Decimal>();
    for (const price of prices) {
        if (price.marketId && price.costOfGoods) {
            cogsPerUnit.set(`${price.dropId}:${price.marketId}`, price.costOfGoods);
        }
    }

    const orders = await prisma.order.findMany({
        select: {
            id: true, productId: true, skuId: true, quantity: true, amount: true,
            currency: true, marketId: true, status: true, placedAt: true, paidAt: true,
        },
        orderBy: { placedAt: 'asc' },
    });

    const claims = await prisma.skuClaim.findMany({
        select: { id: true, skuId: true, claimedAt: true, revokedAt: true },
        orderBy: { claimedAt: 'asc' },
    });

    // The CLAIM row on each SKU's provenance chain, so every accrual can name
    // the tamper-evident event that triggered it (`provenanceLedgerId`).
    const provenance = await prisma.blockchainLedger.findMany({
        where: { txType: 'CLAIM' },
        select: { id: true, skuId: true },
    });
    const provenanceBySku = new Map(provenance.map((row) => [row.skuId, row.id]));

    const financeUserId = (await prisma.user.findFirst({
        where: { email: 'finance@hitbox.demo' }, select: { id: true },
    }))?.id ?? null;
    const opsUserId = (await prisma.user.findFirst({
        where: { email: 'order.manager@hitbox.demo' }, select: { id: true },
    }))?.id ?? null;

    // ── 1. Link each claim to the order that paid for it ────────────────────
    //
    // `Order.claimId` was null on every row, which broke the spine of the whole
    // royalty design: accrual triggers on the claim, and `Order.claimId` is the
    // column that says an order has reached that point. The demo assigns one
    // SKU to several orders, so the pairing is "the earliest paid order on that
    // SKU that settled before the claim" — one claim to one order, and never a
    // claim that predates the payment for it.
    const PAYABLE = new Set(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED']);
    const ordersBySku = new Map<string, typeof orders>();
    for (const order of orders) {
        if (!order.skuId || !PAYABLE.has(order.status)) continue;
        const list = ordersBySku.get(order.skuId) ?? [];
        list.push(order);
        ordersBySku.set(order.skuId, list);
    }

    const claimForOrder = new Map<string, (typeof claims)[number]>();
    const takenOrders = new Set<string>();
    for (const claim of claims) {
        if (claim.revokedAt) continue;
        const candidates = (ordersBySku.get(claim.skuId) ?? [])
            .filter((o) => !takenOrders.has(o.id))
            .filter((o) => (o.paidAt ?? o.placedAt).getTime() <= claim.claimedAt.getTime());
        const order = candidates[0];
        if (!order) continue;
        takenOrders.add(order.id);
        claimForOrder.set(order.id, claim);
    }

    for (const [orderId, claim] of claimForOrder) {
        await prisma.order.update({
            where: { id: orderId },
            data: { claimId: claim.id, claimedAt: claim.claimedAt },
        });
    }

    // ── 2. The deals ────────────────────────────────────────────────────────
    const ruleRows: Prisma.RoyaltyRuleCreateManyInput[] = [];
    for (const deal of DEALS) {
        const artist = artistBySlug.get(deal.artistSlug);
        if (!artist) continue;

        const artistDrops = drops.filter((d) => d.artistId === artist.id);
        const scopedDrop = deal.dropIndex === undefined ? null : artistDrops[deal.dropIndex];
        if (deal.dropIndex !== undefined && !scopedDrop) continue;

        // `splitsOf` reads `splitConfig.splits[]` and ignores anything else, so
        // a multi-party deal has to be written in exactly that shape — the old
        // `{ artist: 20, brand: 10 }` was silently ignored and every such rule
        // quietly fell back to the single `percentage` column.
        const splitConfig = deal.splits
            ? {
                splits: deal.splits.map((s) => ({
                    payeeType: s.payeeType,
                    ...(s.payeeType === 'ARTIST'
                        ? { artistId: artist.id }
                        : { organizationId: artist.organizationId }),
                    percentage: s.percentage,
                })),
            }
            : {};

        ruleRows.push({
            id: id(`royaltyrule:${deal.key}`),
            organizationId: artist.organizationId,
            artistId: artist.id,
            collectionId: null,
            productId: scopedDrop?.id ?? null,
            basis: deal.basis,
            splitType: deal.splitType,
            splitConfig: splitConfig as Prisma.InputJsonValue,
            percentage: deal.percentage === undefined ? null : dec(deal.percentage),
            payoutThreshold: deal.payoutThreshold === null ? null : dec(deal.payoutThreshold),
            payoutFrequency: deal.payoutFrequency,
            effectiveFrom: daysAgo(deal.effectiveFromDays),
            effectiveTo: deal.effectiveToDays === null ? null : daysAgo(deal.effectiveToDays),
            createdAt: daysAgo(deal.effectiveFromDays),
        });
    }
    await prisma.royaltyRule.createMany({ data: ruleRows });

    const rules: RuleRow[] = await prisma.royaltyRule.findMany({
        select: {
            id: true, productId: true, collectionId: true, artistId: true,
            organizationId: true, effectiveFrom: true, effectiveTo: true,
            basis: true, percentage: true, splitConfig: true,
        },
    });

    // ── 3. Accrue, at the claim, through the real calculation ───────────────
    const planned: PlannedEntry[] = [];
    for (const order of orders) {
        const claim = claimForOrder.get(order.id);
        if (!claim) continue;
        const drop = dropById.get(order.productId);
        if (!drop?.artistId) continue;

        // Every rule that could apply to this sale, handed to the resolver in
        // full so most-specific-first is decided by the module, not by us.
        const candidates = rules.filter(
            (rule) =>
                (rule.productId !== null && rule.productId === drop.id) ||
                (rule.collectionId !== null && rule.collectionId === drop.collectionId) ||
                (rule.artistId !== null && rule.artistId === drop.artistId) ||
                (rule.organizationId !== null && rule.organizationId === drop.organizationId),
        );
        const rule = resolveRule(candidates, claim.claimedAt);
        if (!rule) continue;

        const grossRevenue = order.amount;
        const unitCost = order.marketId
            ? cogsPerUnit.get(`${order.productId}:${order.marketId}`)
            : undefined;
        // A drop with no cost on its price row falls back to 40% of gross, the
        // same blended figure the platform ledger has always used here.
        const costOfGoods = unitCost
            ? unitCost.times(order.quantity)
            : grossRevenue.times('0.4').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

        for (const split of splitsOf(rule, drop.artistId)) {
            const payeeId = split.artistId ?? split.organizationId;
            if (!payeeId) continue;

            const math = calculateRoyalty({
                grossRevenue,
                costOfGoods,
                basis: rule.basis,
                percentage: split.percentage,
            });
            if (math.amount.lessThanOrEqualTo(0)) continue;

            planned.push({
                id: id(`royaltyentry:${claim.id}:${rule.id}:${payeeId}`),
                orderId: order.id,
                ruleId: rule.id,
                skuId: claim.skuId,
                claimId: claim.id,
                accrualKey: accrualKeyFor(claim.id, rule.id, payeeId),
                payeeType: split.payeeType as RoyaltyPayeeType,
                payeeArtistId: split.artistId,
                payeeOrganizationId: split.organizationId,
                payeeKey: `${split.payeeType}:${payeeId}`,
                basis: rule.basis,
                percentage: math.percentage,
                grossRevenue: math.grossRevenue,
                costOfGoods: math.costOfGoods,
                netProfit: math.netProfit,
                amount: math.amount,
                currency: order.currency,
                entryType: LedgerEntryType.ORIGINAL,
                status: RoyaltyEntryStatus.ACCRUED,
                adjustsEntryId: null,
                payoutId: null,
                accruedAt: claim.claimedAt,
                paidAt: null,
                createdAt: claim.claimedAt,
                provenanceLedgerId: provenanceBySku.get(claim.skuId) ?? null,
            });
        }
    }

    // ── 4. Reversals come before payouts, as they do in life ────────────────
    //
    // A refund reverses an accrual that has not been paid yet; only entries
    // still ACCRUED are swept into a batch. Doing this first is what keeps the
    // batch totals equal to the rows they settle.
    const refunds = await prisma.refundRequest.findMany({
        where: { status: 'PROCESSED' },
        select: { id: true, orderId: true, approvedAt: true, amount: true },
    });
    const adjustments: Prisma.AdjustmentEntryCreateManyInput[] = [];
    const reversalLedgerLines: Prisma.FinanceLedgerEntryCreateManyInput[] = [];

    for (const refund of refunds) {
        const at = refund.approvedAt ?? daysAgo(5);
        for (const entry of planned.filter((e) => e.orderId === refund.orderId)) {
            entry.status = RoyaltyEntryStatus.REVERSED;
            adjustments.push({
                id: id(`adjustment:reversal:${entry.id}`),
                targetType: AdjustmentTargetType.ROYALTY_LEDGER_ENTRY,
                targetId: entry.id,
                orderId: entry.orderId,
                amountAdjustment: entry.amount.negated(),
                currency: entry.currency,
                reasonCode: AdjustmentReason.REFUND_REVERSAL,
                reason: 'Order refunded — the unit came back, so the accrual is withdrawn.',
                actorId: financeUserId,
                refundRequestId: refund.id,
                disputeCaseId: null,
                resultingEntryId: null,
                metadata: { originalStatus: 'ACCRUED', path: 'REVERSAL' } as Prisma.InputJsonValue,
                status: AdjustmentStatus.EXECUTED,
                approvedById: financeUserId,
                approvedAt: at,
                createdAt: at,
            });
            // The expense comes back off the platform's books too, so margin
            // reporting stops counting a royalty nobody will be paid.
            reversalLedgerLines.push({
                id: id(`finentry:royalty-reversal:${entry.id}`),
                orderId: entry.orderId,
                entryType: LedgerEntryType.ADJUSTMENT,
                direction: FinanceDirection.CREDIT,
                category: FinanceCategory.ROYALTY_EXPENSE,
                amount: entry.amount.negated(),
                currency: entry.currency,
                adjustsEntryId: entry.id,
                postingKey: `royalty-expense-reversal:${entry.id}`,
                description: 'Royalty reversed: order refunded.',
                createdAt: at,
            });
        }
    }

    // ── 5. Payout batches, across all five lifecycle states ─────────────────
    const thresholdByArtist = new Map<string, Prisma.Decimal>();
    const thresholdByOrg = new Map<string, Prisma.Decimal>();
    for (const row of ruleRows) {
        if (row.payoutThreshold === null || row.payoutThreshold === undefined) continue;
        const threshold = dec(row.payoutThreshold as Prisma.Decimal);
        if (row.artistId) thresholdByArtist.set(row.artistId, threshold);
        if (row.organizationId) thresholdByOrg.set(row.organizationId, threshold);
    }
    const DEFAULT_THRESHOLD = dec('500.00');

    // One group per (payee, currency) — the unit a payout batch is drawn from.
    const groups = new Map<string, PlannedEntry[]>();
    for (const entry of planned) {
        if (entry.status !== RoyaltyEntryStatus.ACCRUED) continue;
        const key = `${entry.payeeKey}:${entry.currency}`;
        const list = groups.get(key) ?? [];
        list.push(entry);
        groups.set(key, list);
    }

    // Largest balance first, so the lifecycle states below land on the groups a
    // reviewer will actually open.
    const eligible = [...groups.entries()]
        .map(([key, entries]) => ({
            key,
            entries: entries.sort((a, b) => a.accruedAt.getTime() - b.accruedAt.getTime()),
            total: entries.reduce((sum, e) => sum.plus(e.amount), ZERO),
        }))
        .filter((group) => {
            const first = group.entries[0]!;
            const threshold = first.payeeArtistId
                ? thresholdByArtist.get(first.payeeArtistId) ?? DEFAULT_THRESHOLD
                : thresholdByOrg.get(first.payeeOrganizationId!) ?? DEFAULT_THRESHOLD;
            return group.total.greaterThanOrEqualTo(threshold);
        })
        .sort((a, b) => b.total.comparedTo(a.total));

    // PAID, PAID, APPROVED, SCHEDULED, FAILED, CANCELLED — then anything left
    // over stays ACCRUED, which is what an artist below their threshold looks
    // like and is the state the payout queue is meant to show.
    const LIFECYCLE: PayoutStatus[] = [
        PayoutStatus.PAID, PayoutStatus.PAID, PayoutStatus.APPROVED,
        PayoutStatus.SCHEDULED, PayoutStatus.FAILED, PayoutStatus.CANCELLED,
    ];

    const payouts: Prisma.RoyaltyPayoutCreateManyInput[] = [];
    let batchNo = 0;
    for (const group of eligible) {
        const status = LIFECYCLE[batchNo];
        if (!status) break;

        const first = group.entries[0]!;
        const threshold = first.payeeArtistId
            ? thresholdByArtist.get(first.payeeArtistId) ?? DEFAULT_THRESHOLD
            : thresholdByOrg.get(first.payeeOrganizationId!) ?? DEFAULT_THRESHOLD;

        // A batch settles the entries accrued up to its cut-off, not everything
        // the payee has ever earned — so there is always a live balance behind
        // a paid batch, which is what the balances screen is for.
        const cutoff = status === PayoutStatus.PAID ? 0.6 : 1;
        const covered = group.entries.slice(0, Math.max(1, Math.ceil(group.entries.length * cutoff)));
        const total = covered.reduce((sum, e) => sum.plus(e.amount), ZERO);

        const payoutId = id(`payout:${group.key}:${batchNo}`);
        const lastAccrual = covered[covered.length - 1]!.accruedAt;
        const scheduledAt = new Date(Math.min(
            NOW.getTime() - 2 * 86_400_000,
            lastAccrual.getTime() + 5 * 86_400_000,
        ));
        const approvedAt = new Date(scheduledAt.getTime() + 86_400_000);
        const paidAt = new Date(approvedAt.getTime() + 2 * 86_400_000);

        const settled = status === PayoutStatus.PAID;
        const approved = settled || status === PayoutStatus.APPROVED;
        // FAILED and CANCELLED release their entries back to ACCRUED, exactly as
        // `RoyaltyPayoutService.fail` does — a bounced transfer must never
        // strand an artist's earnings in a state no sweep looks at.
        const released = status === PayoutStatus.FAILED || status === PayoutStatus.CANCELLED;

        for (const entry of covered) {
            if (released) continue;
            entry.payoutId = payoutId;
            entry.status = settled ? RoyaltyEntryStatus.PAID : RoyaltyEntryStatus.PENDING_PAYOUT;
            entry.paidAt = settled ? paidAt : null;
        }

        payouts.push({
            id: payoutId,
            payeeType: first.payeeType,
            payeeArtistId: first.payeeArtistId,
            payeeOrganizationId: first.payeeOrganizationId,
            amount: total,
            currency: first.currency,
            entryCount: covered.length,
            thresholdApplied: threshold,
            status,
            scheduledAt,
            approvedById: approved ? financeUserId : null,
            approvedAt: approved ? approvedAt : null,
            approvalReason: approved
                ? `${covered.length} entries cleared the ${threshold.toFixed(2)} ${first.currency} threshold.`
                : null,
            transferInitiatedById: settled ? financeUserId : null,
            transferInitiatedAt: settled ? new Date(approvedAt.getTime() + 3600_000) : null,
            payoutPeriodStart: monthStart(covered[0]!.accruedAt),
            payoutPeriodEnd: monthEnd(lastAccrual),
            gatewayPayoutRef: settled ? `po_demo_${payoutId.slice(0, 12)}` : null,
            paidAt: settled ? paidAt : null,
            failureReason: status === PayoutStatus.FAILED
                ? 'Provider rejected the transfer: the payee bank account could not be verified.'
                : status === PayoutStatus.CANCELLED
                    ? 'Cancelled before approval — the payee is mid-way through updating their tax details.'
                    : null,
            createdAt: scheduledAt,
            updatedAt: settled ? paidAt : approved ? approvedAt : scheduledAt,
        });
        batchNo += 1;
    }

    // Batches before entries: an entry carries `payoutId`, so the batch it
    // names has to exist before the row that names it.
    await prisma.royaltyPayout.createMany({ data: payouts });
    await prisma.royaltyLedgerEntry.createMany({
        data: planned.map(({ payeeKey: _payeeKey, ...row }) => row),
    });

    // ── 6. A clawback on money that already left ────────────────────────────
    //
    // The other half of the correction story: an entry that is already PAID
    // cannot be marked REVERSED, because the artist has the money. It is
    // corrected by a negative ADJUSTMENT entry that nets off the next batch,
    // keyed `reversal:<entryId>` so a retry cannot double-claw.
    const clawbackTarget = planned.find((e) => e.status === RoyaltyEntryStatus.PAID);
    if (clawbackTarget) {
        const at = daysAgo(3);
        const clawbackId = id(`royaltyentry:clawback:${clawbackTarget.id}`);
        await prisma.royaltyLedgerEntry.create({
            data: {
                id: clawbackId,
                orderId: clawbackTarget.orderId,
                ruleId: clawbackTarget.ruleId,
                skuId: clawbackTarget.skuId,
                claimId: clawbackTarget.claimId,
                accrualKey: reversalKeyFor(clawbackTarget.id),
                payeeType: clawbackTarget.payeeType,
                payeeArtistId: clawbackTarget.payeeArtistId,
                payeeOrganizationId: clawbackTarget.payeeOrganizationId,
                basis: clawbackTarget.basis,
                percentage: clawbackTarget.percentage,
                grossRevenue: clawbackTarget.grossRevenue,
                costOfGoods: clawbackTarget.costOfGoods,
                netProfit: clawbackTarget.netProfit,
                amount: clawbackTarget.amount.negated(),
                currency: clawbackTarget.currency,
                entryType: LedgerEntryType.ADJUSTMENT,
                status: RoyaltyEntryStatus.ACCRUED,
                adjustsEntryId: clawbackTarget.id,
                accruedAt: at,
                createdAt: at,
            },
        });
        adjustments.push({
            id: id(`adjustment:clawback:${clawbackTarget.id}`),
            targetType: AdjustmentTargetType.ROYALTY_LEDGER_ENTRY,
            targetId: clawbackTarget.id,
            orderId: clawbackTarget.orderId,
            amountAdjustment: clawbackTarget.amount.negated(),
            currency: clawbackTarget.currency,
            reasonCode: AdjustmentReason.DISPUTE_LOSS,
            reason: 'Chargeback lost after the payout had settled — clawed back against the next batch.',
            actorId: financeUserId,
            refundRequestId: null,
            disputeCaseId: null,
            resultingEntryId: clawbackId,
            metadata: { originalStatus: 'PAID', path: 'CLAWBACK' } as Prisma.InputJsonValue,
            status: AdjustmentStatus.EXECUTED,
            approvedById: financeUserId,
            approvedAt: at,
            createdAt: at,
        });
        reversalLedgerLines.push({
            id: id(`finentry:royalty-clawback:${clawbackTarget.id}`),
            orderId: clawbackTarget.orderId,
            entryType: LedgerEntryType.ADJUSTMENT,
            direction: FinanceDirection.CREDIT,
            category: FinanceCategory.ROYALTY_EXPENSE,
            amount: clawbackTarget.amount.negated(),
            currency: clawbackTarget.currency,
            adjustsEntryId: clawbackTarget.id,
            postingKey: `royalty-expense-reversal:${clawbackTarget.id}`,
            description: 'Royalty clawed back: chargeback lost.',
            createdAt: at,
        });
    }

    // ── 7. Manual corrections, so every reason code and status is reachable ─
    const correctionOrders = orders.filter((o) => claimForOrder.has(o.id)).slice(0, 4);
    const payment = await prisma.paymentTransaction.findFirst({
        select: { id: true, orderId: true, amount: true, currency: true },
        orderBy: { createdAt: 'desc' },
    });

    if (correctionOrders[0]) {
        const order = correctionOrders[0];
        adjustments.push({
            id: id('adjustment:goodwill'),
            targetType: AdjustmentTargetType.ORDER,
            targetId: order.id,
            orderId: order.id,
            amountAdjustment: dec(order.currency === Currency.INR ? 500 : 10),
            currency: order.currency,
            reasonCode: AdjustmentReason.GOODWILL,
            reason: 'Goodwill credit — the drop shipped eleven days late.',
            actorId: opsUserId,
            refundRequestId: null, disputeCaseId: null, resultingEntryId: null,
            metadata: { approvedInMeeting: 'ops-weekly' } as Prisma.InputJsonValue,
            status: AdjustmentStatus.EXECUTED,
            approvedById: financeUserId,
            approvedAt: daysAgo(12),
            createdAt: daysAgo(13),
        });
    }
    if (correctionOrders[1]) {
        const order = correctionOrders[1];
        // Deliberately left unapproved: the adjustments queue on the finance
        // dashboard is meaningless if it is always empty.
        adjustments.push({
            id: id('adjustment:calc-error'),
            targetType: AdjustmentTargetType.ROYALTY_LEDGER_ENTRY,
            targetId: planned.find((e) => e.orderId === order.id)?.id ?? order.id,
            orderId: order.id,
            amountAdjustment: dec(order.currency === Currency.INR ? -250 : -4.5),
            currency: order.currency,
            reasonCode: AdjustmentReason.CALCULATION_ERROR,
            reason: 'COGS was understated on the first production run; royalty was over-accrued.',
            actorId: financeUserId,
            refundRequestId: null, disputeCaseId: null, resultingEntryId: null,
            metadata: { raisedBy: 'month-end review' } as Prisma.InputJsonValue,
            status: AdjustmentStatus.PENDING_APPROVAL,
            approvedById: null, approvedAt: null,
            createdAt: daysAgo(4),
        });
    }
    if (correctionOrders[2]) {
        const order = correctionOrders[2];
        adjustments.push({
            id: id('adjustment:rule-correction'),
            targetType: AdjustmentTargetType.ROYALTY_LEDGER_ENTRY,
            targetId: planned.find((e) => e.orderId === order.id)?.id ?? order.id,
            orderId: order.id,
            amountAdjustment: dec(order.currency === Currency.INR ? 300 : 6),
            currency: order.currency,
            reasonCode: AdjustmentReason.RULE_CORRECTION,
            reason: 'Claimed the renegotiated rate applied retroactively; it does not.',
            actorId: opsUserId,
            refundRequestId: null, disputeCaseId: null, resultingEntryId: null,
            metadata: { ticket: 'FIN-1042' } as Prisma.InputJsonValue,
            status: AdjustmentStatus.REJECTED,
            approvedById: financeUserId,
            approvedAt: daysAgo(8),
            createdAt: daysAgo(10),
        });
    }
    if (payment) {
        adjustments.push({
            id: id('adjustment:chargeback-fee'),
            targetType: AdjustmentTargetType.PAYMENT_TRANSACTION,
            targetId: payment.id,
            orderId: payment.orderId,
            amountAdjustment: dec(payment.currency === Currency.INR ? -1500 : -15),
            currency: payment.currency,
            reasonCode: AdjustmentReason.CHARGEBACK_FEE,
            reason: 'Gateway chargeback fee, passed through to the platform.',
            actorId: financeUserId,
            refundRequestId: null, disputeCaseId: null, resultingEntryId: null,
            metadata: { gateway: 'STRIPE' } as Prisma.InputJsonValue,
            status: AdjustmentStatus.EXECUTED,
            approvedById: financeUserId,
            approvedAt: daysAgo(6),
            createdAt: daysAgo(6),
        });
    }

    await prisma.adjustmentEntry.createMany({ data: adjustments });

    // ── 8. The platform's own books ─────────────────────────────────────────
    //
    // Previously this table held SALE_REVENUE and nothing else, so every margin
    // figure on the dashboard was gross revenue wearing a different label. All
    // six categories are posted here, double-entry, one set per settled order.
    const financeLines: Prisma.FinanceLedgerEntryCreateManyInput[] = [];
    const royaltyByOrder = new Map<string, Prisma.Decimal>();
    for (const entry of planned) {
        if (entry.status === RoyaltyEntryStatus.REVERSED) continue;
        royaltyByOrder.set(
            entry.orderId,
            (royaltyByOrder.get(entry.orderId) ?? ZERO).plus(entry.amount),
        );
    }
    const refundByOrder = new Map(refunds.map((r) => [r.orderId, r]));

    for (const order of orders) {
        if (!PAYABLE.has(order.status)) continue;
        const at = order.paidAt ?? order.placedAt;
        const unitCost = order.marketId
            ? cogsPerUnit.get(`${order.productId}:${order.marketId}`)
            : undefined;
        const cogs = unitCost
            ? unitCost.times(order.quantity)
            : order.amount.times('0.4').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        const fee = gatewayFee(order.amount, order.currency);

        financeLines.push({
            id: id(`finentry:sale:${order.id}`),
            orderId: order.id,
            entryType: LedgerEntryType.ORIGINAL,
            direction: FinanceDirection.CREDIT,
            category: FinanceCategory.SALE_REVENUE,
            amount: order.amount,
            currency: order.currency,
            costOfGoods: cogs,
            gatewayFee: fee,
            postingKey: `sale:${order.id}`,
            description: `Sale settled — ${dropById.get(order.productId)?.name ?? 'drop'}`,
            createdAt: at,
        });
        financeLines.push({
            id: id(`finentry:cogs:${order.id}`),
            orderId: order.id,
            entryType: LedgerEntryType.ORIGINAL,
            direction: FinanceDirection.DEBIT,
            category: FinanceCategory.COST_OF_GOODS,
            amount: cogs,
            currency: order.currency,
            costOfGoods: cogs,
            postingKey: `cogs:${order.id}`,
            description: 'Manufacturing, authentication and tag.',
            createdAt: at,
        });
        financeLines.push({
            id: id(`finentry:fee:${order.id}`),
            orderId: order.id,
            entryType: LedgerEntryType.ORIGINAL,
            direction: FinanceDirection.DEBIT,
            category: FinanceCategory.GATEWAY_FEE,
            amount: fee,
            currency: order.currency,
            gatewayFee: fee,
            postingKey: `fee:${order.id}`,
            description: 'Stripe processing fee (2.9% + fixed).',
            createdAt: at,
        });

        const royalty = royaltyByOrder.get(order.id);
        if (royalty && royalty.greaterThan(0)) {
            const claim = claimForOrder.get(order.id);
            financeLines.push({
                id: id(`finentry:royalty:${order.id}`),
                orderId: order.id,
                entryType: LedgerEntryType.ORIGINAL,
                direction: FinanceDirection.DEBIT,
                category: FinanceCategory.ROYALTY_EXPENSE,
                amount: royalty,
                currency: order.currency,
                postingKey: `royalty-expense:${order.id}`,
                description: 'Royalty accrued to the artist at claim.',
                createdAt: claim?.claimedAt ?? at,
            });
        }

        const refund = refundByOrder.get(order.id);
        if (refund) {
            financeLines.push({
                id: id(`finentry:refund:${order.id}`),
                orderId: order.id,
                entryType: LedgerEntryType.ADJUSTMENT,
                direction: FinanceDirection.DEBIT,
                category: FinanceCategory.REFUND,
                amount: refund.amount,
                currency: order.currency,
                postingKey: `refund:${refund.id}`,
                description: 'Refund issued to the buyer.',
                createdAt: refund.approvedAt ?? daysAgo(5),
            });
        }
    }

    // The cash side of every settled batch, keyed exactly as
    // `RoyaltyPayoutService.execute` keys it.
    for (const payout of payouts.filter((p) => p.status === PayoutStatus.PAID)) {
        financeLines.push({
            id: id(`finentry:payout:${payout.id}`),
            entryType: LedgerEntryType.ORIGINAL,
            direction: FinanceDirection.DEBIT,
            category: FinanceCategory.ROYALTY_PAYOUT,
            amount: payout.amount,
            currency: payout.currency,
            postingKey: `payout:${payout.id}`,
            description: `Royalty payout ${payout.gatewayPayoutRef}`,
            createdAt: payout.paidAt as Date,
        });
    }

    financeLines.push(...reversalLedgerLines);
    await prisma.financeLedgerEntry.createMany({ data: financeLines });

    return {
        rules: ruleRows.length,
        entries: planned.length + (clawbackTarget ? 1 : 0),
        payouts: payouts.length,
        adjustments: adjustments.length,
        financeEntries: financeLines.length,
        ordersLinkedToClaims: claimForOrder.size,
    };
}

// ── Standalone entry point ──────────────────────────────────────────────────

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('seed-finance.ts');
if (isDirectRun) {
    seedFinanceDemo()
        .then(async (summary) => {
            console.log('▸ finance demo data rebuilt');
            console.log(`  orders linked to claims: ${summary.ordersLinkedToClaims}`);
            console.log(`  royalty rules:           ${summary.rules}`);
            console.log(`  royalty ledger entries:  ${summary.entries}`);
            console.log(`  payout batches:          ${summary.payouts}`);
            console.log(`  adjustments:             ${summary.adjustments}`);
            console.log(`  platform ledger lines:   ${summary.financeEntries}`);
            await prisma.$disconnect();
        })
        .catch(async (error) => {
            console.error(error);
            await prisma.$disconnect();
            process.exit(1);
        });
}
