# Finance Demo Data

> What `pnpm db:seed:finance` puts in the database, why each row is shaped the
> way it is, and what the old inline seed got wrong.
>
> Related: [royalty-lifecycle.md](royalty-lifecycle.md) (the states these rows
> move through), [finance-revenue-ledger.md](finance-revenue-ledger.md) (the
> design), [api-reference.md](api-reference.md) (the endpoints that read it).

---

## Running it

```bash
pnpm --filter @hitbox/database db:seed:finance
```

Rebuilds `RoyaltyRule`, `RoyaltyLedgerEntry`, `RoyaltyPayout`, `AdjustmentEntry`
and `FinanceLedgerEntry` **from the artists, drops, orders and claims already in
the database**. It does not create an artist or an order; it reads what is there
and derives the money from it. Safe to re-run — ids are deterministic and it
clears the five tables first.

`pnpm db:seed:demo` calls it at the end, on the data it has just created, so a
full demo seed still produces all of this in one command.

## The rule it follows

**The numbers are computed by the same code the API runs.** `calculateRoyalty`,
`resolveRule`, `splitsOf`, `accrualKeyFor` and `reversalKeyFor` are imported
from `@hitbox/finance` rather than reimplemented in the seed. A fixture that
recomputes a formula by hand is a fixture that drifts from the formula, and a
royalty demo that disagrees with the royalty engine is worse than no demo at
all.

That is why `@hitbox/database` depends on `@hitbox/finance` — exactly the
arrangement already in place for `@hitbox/audit` and `@hitbox/access-control`,
whose seeds likewise read their own module's source of truth.

## What was wrong before

The finance block used to live inline in `seed-demo.ts` and produced rows that
were the right *shape* and the wrong *content* — the worst kind of demo data,
because every screen renders, every number is a lie, and nothing fails loudly
enough to notice. Every royalty entry it wrote had:

| Column | What it held | Why that mattered |
| --- | --- | --- |
| `payeeArtistId`, `payeeOrganizationId` | **both null**, on all 49 rows | Not one penny in the ledger was attributable to an artist. `balances()` folded all three artists into a single anonymous `payeeId: null` bucket, so the artist earnings screen and the payout queue were both meaningless. |
| `basis` | `NET_PROFIT` | while the rule it named said `GROSS_REVENUE` — the entry contradicted its own rule. |
| `percentage`, `grossRevenue`, `costOfGoods`, `netProfit` | all null | The "an entry carries its own arithmetic" guarantee — the thing that lets an accrual be re-checked years later without re-reading a price table that has since changed — held no arithmetic at all. |
| `accrualKey` | the row's own UUID | Not `claim:…:rule:…:payee:…`. The UNIQUE index that is the whole duplicate-accrual defence guarded nothing, because no two runs would ever collide. |
| `skuId`, `claimId` | null | Severed from the claim that is supposed to have triggered the accrual. |

`RoyaltyPayout` and `AdjustmentEntry` had **zero rows**, so the entire payout
lifecycle and the entire corrections story were undemonstrated. `RoyaltyRule`
carried `splitConfig: { artist: 20, brand: 10 }` — a shape `splitsOf` does not
read, so every such rule silently fell back to the single `percentage` column
and no `ORGANIZATION` payee ever existed.

`Order.claimId` was null on all 60 orders, which broke the spine of the design:
royalty accrues at the claim, and that column is what says an order has reached
that point.

## What it writes now

### 1. `Order.claimId` — the link that was missing

The demo assigns one SKU to several orders, so the pairing is *"the earliest
paid order on that SKU that settled before the claim"* — one claim to one order,
and never a claim that predates the payment for it. **34 of 60 orders** link;
the rest are `PENDING_PAYMENT` / `CANCELLED` (no SKU assigned) or their SKU's
claim happened before that order settled. An order that is paid and never
claimed owes the artist nothing, which is the point.

### 2. Five royalty rules — four resolver shapes

| Deal | Artist | Basis | Terms | What it demonstrates |
| --- | --- | --- | --- | --- |
| `ronin-2025` | Ronin | `NET_PROFIT` | artist 15% + label 6% | **Superseded.** `effectiveTo` set, kept rather than deleted, so re-running a July order reproduces July's number. |
| `ronin-current` | Ronin | `NET_PROFIT` | artist 18% + label 7% | **Multi-party.** The only deal using `splitConfig.splits[]`, in the shape `splitsOf` actually reads — and the reason `ORGANIZATION` payees exist in the ledger at all. |
| `lumen` | Lumen | `GROSS_REVENUE` | 22% | **Gross basis**, so COGS demonstrably does not affect the payout. |
| `kaze` | Kaze | `NET_PROFIT` | 35%, quarterly | Self-released: higher rate, slower sweep. |
| `kaze-collab` | Kaze | `GROSS_REVENUE` | 45%, one drop | **Drop-scoped**, so it must beat the artist-scoped rule above for that drop and only that drop — `resolveRule`'s most-specific-first branch, exercised by real data. |

### 3. Royalty entries — accrued at the claim

One per `(claim, rule, payee)`, so a Ronin sale writes two rows: the artist's
and the label's. Each carries `grossRevenue` (the order's snapshotted amount),
`costOfGoods` (the drop's price row for that market × quantity), `netProfit`,
`basis`, `percentage` and `amount` — every figure computed by `calculateRoyalty`
and independently re-derivable. `provenanceLedgerId` names the `BlockchainLedger`
CLAIM row that triggered it.

### 4. Payout batches — all five lifecycle states

Groups are `(payee, currency)`; a group is eligible when its accrued total
clears the payee's `payoutThreshold`.

| Status | Entries | What it shows |
| --- | --- | --- |
| `PAID` ×2 | `PAID`, `payoutId` set, `paidAt` set | Settled money, with `gatewayPayoutRef`, `approvedById`, `transferInitiatedById` and the period dates. Covers ~60% of the group, so there is always a live balance behind a paid batch. |
| `APPROVED` | `PENDING_PAYOUT` | Approved, awaiting the transfer. |
| `SCHEDULED` | `PENDING_PAYOUT` | Swept, awaiting a human decision — the payout queue. |
| `FAILED` | released back to `ACCRUED`, `payoutId` null | The provider rejected it. Matches `RoyaltyPayoutService.fail` exactly: a bounced transfer must never strand an artist's earnings in a state no sweep looks at. |
| `CANCELLED` | released back to `ACCRUED` | Cancelled before approval. |

Batch `amount` and `entryCount` always equal the rows the batch settles — a
statement that does not reconcile is the bug this data exists to catch.

### 5. Corrections — every reason code, and both paths

Reversals run **before** the payout sweep, as they do in life: only `ACCRUED`
entries are swept, so a refund cannot invalidate a batch that already counted
it.

- **6 × `REFUND_REVERSAL`** (`EXECUTED`) — the entry goes `REVERSED`, an
  `AdjustmentEntry` points at it, and a `ROYALTY_EXPENSE` credit takes the
  expense back off the platform's books.
- **1 × `DISPUTE_LOSS`** (`EXECUTED`) — the **clawback** path. An entry that is
  already `PAID` cannot be marked `REVERSED`, because the artist has the money;
  it is corrected by a negative `ADJUSTMENT` entry keyed `reversal:<entryId>`
  that nets off the next batch.
- **`GOODWILL`** (`EXECUTED`), **`CHARGEBACK_FEE`** (`EXECUTED`),
  **`RULE_CORRECTION`** (`REJECTED`), and **`CALCULATION_ERROR`**
  (`PENDING_APPROVAL`) — the last deliberately left unapproved, because an
  adjustments queue that is always empty tells a reviewer nothing.

### 6. Platform ledger — all six categories

Previously this table held `SALE_REVENUE` and nothing else, so every margin
figure on the dashboard was gross revenue wearing a different label. Now each
settled order posts `SALE_REVENUE` (credit), `COST_OF_GOODS` (debit),
`GATEWAY_FEE` (debit, 2.9% + fixed) and `ROYALTY_EXPENSE` (debit), plus
`REFUND` where one was issued and `ROYALTY_PAYOUT` per settled batch — keyed
`payout:<id>`, exactly as `RoyaltyPayoutService.execute` keys it.

## The resulting balances

What `GET /api/v1/admin/finance/royalties/balances` returns:

| Payee | Cur | Accrued | Pending | Paid | Reversed | Outstanding | Threshold | Met |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :-: |
| Ronin | INR | 0.00 | 1468.80 | 0.00 | 0.00 | 1468.80 | 50.00 | no |
| Ronin Collective | INR | 0.00 | 571.20 | 0.00 | 0.00 | 571.20 | 50.00 | no |
| Kaze | GBP | 92.70 | 0.00 | 0.00 | 79.20 | 92.70 | 75.00 | **yes** |
| Kaze | USD | 92.25 | 0.00 | 0.00 | 0.00 | 92.25 | 75.00 | **yes** |
| Lumen | USD | 53.90 | 0.00 | 0.00 | 0.00 | 53.90 | 50.00 | **yes** |
| Ronin | GBP | 51.84 | 0.00 | 0.00 | 11.88 | 51.84 | 50.00 | **yes** |
| Ronin | USD | 35.64 | 0.00 | 0.00 | 0.00 | 35.64 | 50.00 | no |
| Lumen | GBP | 32.34 | 0.00 | 0.00 | 0.00 | 32.34 | 50.00 | no |
| Ronin Collective | GBP | 20.16 | 0.00 | 0.00 | 4.62 | 20.16 | 50.00 | no |
| Ronin Collective | USD | 13.86 | 0.00 | 0.00 | 0.00 | 13.86 | 50.00 | no |
| Lumen | INR | 0.00 | 0.00 | 1716.00 | 0.00 | 0.00 | 50.00 | no |
| Kaze | INR | **−945.00** | 0.00 | 4455.00 | 0.00 | −945.00 | 75.00 | no |

Two rows there are worth reading twice.

**Kaze / INR is negative.** That is the clawback, sitting against future
earnings — the design's stated behaviour for money that has already gone out,
and it exercises `schedule()`'s `"Net accrual is zero or negative — nothing to
pay"` skip path with real data rather than a unit test's mock.

**The label always trails its artist.** Ronin Collective's 7% accrues alongside
Ronin's 18% against the same sales, so it crosses the same threshold far later.
A payout queue that only ever shows artists hides that entirely.

## ⚠️ One threshold, many currencies

`RoyaltyRule.payoutThreshold` is a single `Decimal` with **no currency on it**,
so one number governs a payee's GBP, USD and INR balances alike — `50` reads as
"$50" against a USD balance and "₹50" against an INR one, which are not the same
amount of money. This is a real limitation of the schema, not an artefact of the
demo, and it is why every INR balance above sweeps on the first attempt while
the USD and GBP balances take months to clear the same number.

Worth fixing before any payee is ever paid in two currencies at once. The demo
thresholds are chosen to make it visible rather than to hide it.

## Known-good invariants

These hold on the seeded data and are worth re-checking after any change:

| Invariant | Why it matters |
| --- | --- |
| Every entry names an artist or an organization | Without it, no balance resolves to a payee |
| `amount` = `base × percentage ÷ 100`, rounded half-up, where `base` is `netProfit` or `grossRevenue` per `basis` | The entry is independently re-derivable |
| `netProfit` = `max(0, gross − cogs)` | A sale below cost owes the artist nothing rather than owing HitBox money back |
| Every `ORIGINAL` entry has `skuId`, `claimId` and an `accrualKey` starting `claim:` | Accrual is at the claim, and retries collide |
| Batch `amount` = Σ of its attached entries; `entryCount` = their count | A statement that does not reconcile |
| `PAID` batch → entries `PAID` with `paidAt`; `APPROVED`/`SCHEDULED` → `PENDING_PAYOUT`; `FAILED`/`CANCELLED` → zero attached, entries back to `ACCRUED` | "The batch is paid but its entries still say pending" is the state that pays an artist twice |
