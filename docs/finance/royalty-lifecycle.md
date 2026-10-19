# The royalty lifecycle

The source document traces one collectible from purchase to payout. This
document traces the same collectible through the actual code.

> **Scenario** (from the source document)
> LeBron 'Game-Worn' Jersey #23 · artist `artist_123` · product `product_456`
> Royalty 15% of net profit · market USD · COGS $25 · sale price $100

## Why accrual happens at the claim

This is the decision everything else follows from, and it is worth being
explicit about.

The buyer pays on day 1. HitBox has not delivered anything until the physical
item is in their hands and the NFC tag is tapped on day 6. An order that is paid
and never claimed — lost in transit, returned before delivery, charged back a
week later — has earned the artist nothing. Accruing at payment would mean
spending the next month un-accruing things, and every artist statement would be
provisional.

So the trigger is the `claims.product.claimed` event, and the subscription is
three lines in `packages/finance/src/module.ts`:

```ts
deps.eventBus.subscribe<ClaimedEventPayload>('claims.product.claimed', async (payload) => {
    try { await accrual.accrueForClaim(payload); }
    catch (error) { logger.error({ err: error, ... }, 'royalty accrual failed — replay required'); }
});
```

The handler swallows its own error deliberately. The buyer has tapped their tag
and owns their collectible whatever the royalty configuration says; an exception
here must not surface as a failed claim on someone's phone. A royalty that could
not be posted is an operational problem to alert on, and the log line carries
everything needed to replay it.

## Day 1, 2:15 PM — payment submitted

`POST /api/v1/checkout` → `CheckoutService.checkout`

1. `orders.placeOrder(...)` creates the `Order` (`PENDING_PAYMENT`) and an
   `InventoryReservation` (`HELD`, expiring in `INVENTORY_HOLD_SECONDS`), in one
   transaction.
2. `gatewayConfigs.resolve(...)` picks the credentials binding: DROP beats
   ORGANIZATION beats PLATFORM.
3. A `PaymentTransaction` is created `INITIATED`, with
   `idempotencyKey = order:<orderId>:attempt:1` — derived from the order, not
   random, so a client retrying the same checkout lands on the same transaction.

Nothing here decides the buyer has paid.

## Day 1, 2:16 PM — webhook: payment succeeded

`POST /webhooks/payments/stripe` → `WebhookService.handleStripe` →
`PaymentService.settle`

Signature verified over the raw bytes, event recorded (the insert on the
provider's event id *is* the duplicate check), then four things in order:

1. `PaymentTransaction` → `SUCCEEDED`, guarded on
   `status IN (INITIATED, PENDING, NEEDS_REVIEW)`. **The guard is the
   idempotency**: a redelivered webhook matches zero rows and nothing below runs.
2. `Order` → `PAID`, reservation → `COMMITTED`, `Order.skuId` assigned.
3. `FinanceLedgerEntry`: `SALE_REVENUE`, `CREDIT`, `postingKey = sale:<txnId>`.
4. Audit: `payment.settle`.

Still no royalty. The artist has earned nothing yet.

## Day 6, 3:15 PM — the tag is tapped

`POST /api/v1/claims/:tagId/confirm` → claims writes the claim, the ownership
period and the hash chain, then publishes `claims.product.claimed`. Two
subscribers react:

**Orders** links the claim back to the order — `Order.claimId`, `claimedAt`,
guarded on `claimId: null` so a redelivered event cannot overwrite the first
claim with a later one.

**Finance** accrues (`RoyaltyAccrualService.accrueForClaim`):

1. `orderRevenue.findAccruableOrderForSku(skuId)` — the settled order behind
   this unit, through the port. Null is an ordinary answer (a giveaway, a
   promotional send, a support replacement) and means "nothing to post".
2. `rules.findCandidates(...)` then `resolveRule(rules, claimedAt)` —
   most-specific-first: **product → collection → artist → organization**, then
   latest `effectiveFrom` among equals, filtered by the effective window at the
   moment of the *claim*, not now. That last detail is what makes re-running a
   February order reproduce February's number.
3. `splitsOf(rule, order.artistId)` — one payee for a simple deal, N for a
   `splitConfig`.
4. For each payee, `calculateRoyalty`:

   ```text
   netProfit = 100.00 − 25.00 = 75.00
   amount    = 75.00 × 15 / 100 = 11.25
   ```

5. `RoyaltyLedgerEntry` written `ACCRUED`, carrying `grossRevenue`,
   `costOfGoods`, `netProfit`, `basis`, `percentage` — and `accrualKey`, which
   is UNIQUE and is why step 5 is safe to run twice.
6. `FinanceLedgerEntry`: `ROYALTY_EXPENSE`, `DEBIT`, keyed on the entry id.
7. Audit: `royalty.accrue`.

Everything is `Prisma.Decimal`. Money never touches a JavaScript number: 0.1 +
0.2 is not 0.3, and an append-only ledger cannot quietly fix a rounding error
later. There is a test that accrues 1,000 times and asserts the total is exactly
`10.00`.

### Two deliberate edge cases

**A sale below cost owes nothing** rather than owing HitBox money back. A
negative accrual would net against unrelated sales and silently reduce a payout
the artist has already been told about. Clawing that back is an
`AdjustmentEntry` with a reason on it — a decision someone makes, not a side
effect of arithmetic.

**A zero accrual writes no row.** It adds nothing to any balance and makes every
statement longer.

## Oct 31 — threshold met

`POST /api/v1/admin/finance/payouts/schedule` → `RoyaltyPayoutService.schedule`
(run it as a job, or with `dryRun: true` to preview).

For each payee × currency:

* `balances()` folds the grouped aggregate into accrued / pending / paid /
  reversed.
* The threshold is the payee's rule's `payoutThreshold`, else
  `ROYALTY_DEFAULT_PAYOUT_THRESHOLD` (`500.00` — the document's figure, as a
  default rather than a constant). It gates the **ACCRUED pool only**: entries
  already in a batch are spoken for, and counting them again would sweep a payee
  over the line on money that is already being paid.
* Below threshold → skipped, with the reason returned to the caller.
* At or above → a `RoyaltyPayout` is created and the entries are attached with a
  guarded `updateMany` on `status = ACCRUED AND payoutId IS NULL`. **If fewer
  rows match than were read** — someone reversed an entry in between — the
  transaction rolls back and that payee is skipped rather than paid a number
  that no longer matches its entries.
* Entries → `PENDING_PAYOUT`. Audit: `royalty.payout.schedule`.

The batch total is summed **from the entries**, not from the aggregate: a
statement that does not reconcile against the rows it settles is worse than no
statement.

## Nov 5 — payout executed

Three separate calls, because they are three separate acts with different actors
and different failure modes. Collapsing them would mean a scheduling bug could
pay an artist, and a provider outage could look like a rejected payout.

| Call | Who | What it means |
| --- | --- | --- |
| `POST /payouts/:id/approve` | a person | "yes, spend this money" |
| `POST /payouts/:id/execute` | finance, with the provider's reference | the provider confirmed it moved |
| `POST /payouts/:id/fail` | — | it bounced; entries are released back to `ACCRUED` so the next sweep picks them up |

`execute` runs the batch status flip **and** the entry status flip in one
transaction, and refuses if the number of entries settled does not equal
`entryCount`. "The batch is paid but its 45 entries still say pending" is the
state that gets an artist paid twice.

It also posts the platform's cash side: `ROYALTY_PAYOUT`, `DEBIT`, keyed on the
payout id.

## Reversal and clawback

> Day 21 — *"Royalty Reversal Triggered: adjustment_entry created with
> amount_adjustment = −11.25, reversing the original royalty. The original
> royalty entry is NEVER deleted."*

`RoyaltyAccrualService.reverseForOrder`, called by the refund and dispute paths
through the `IRoyaltyReversal` port. Two paths, chosen per entry by what has
already happened to the money — and the difference matters, because the first is
a correction and the second is a debt:

**Not yet paid** (`ACCRUED` / `PENDING_PAYOUT`) — the entry is marked `REVERSED`
and drops out of the payee's outstanding balance. The row keeps its original
amount: a reversed entry is not a zeroed entry. An `AdjustmentEntry` records
what cancelled it and why, and the royalty expense is credited back off the
platform's books so margin stops counting it.

**Already `PAID`** — the money is in the artist's bank account and cannot be
un-sent. A **negative** `ADJUSTMENT` entry is posted instead (`accrualKey =
reversal:<entryId>`, also UNIQUE, so a retried refund cannot claw back twice),
status `ACCRUED`, so it nets off their next batch. The adjustment row points at
both.

Each entry's reversal is one transaction: the status change or the clawback
posting, the adjustment row, the platform-ledger credit, and the audit record
all commit together. A correction whose audit row failed is a correction nobody
can account for, which is precisely what the immutability principle exists to
prevent.

`POST /admin/finance/royalty-entries/:entryId/reverse` reverses **one** entry,
not the order's — an operator correcting a mis-calculated split on a three-way
deal must be able to fix that one posting without cancelling the other two
payees' earnings.

## Where to look in the code

| Concern | File |
| --- | --- |
| The arithmetic and rule resolution | `packages/finance/src/domain/royalty-calculation.ts` |
| Accrual and reversal | `packages/finance/src/service/royalty-accrual.service.ts` |
| Threshold sweep and batch lifecycle | `packages/finance/src/service/royalty-payout.service.ts` |
| Rules (create, close — never edit) | `packages/finance/src/service/royalty-rule.service.ts` |
| Ledger reads, adjustments, revenue summary | `packages/finance/src/service/finance-ledger.service.ts` |
| The worked example, as a test | `packages/finance/tests/royalty-calculation.test.ts` |
