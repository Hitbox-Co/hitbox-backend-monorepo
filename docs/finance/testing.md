# Testing

## Running

```bash
pnpm --filter @hitbox/finance test
```

```bash
pnpm --filter @hitbox/payments test
```

Both packages use jest + ts-jest compiling to CommonJS, matching the existing
setup in `@hitbox/skus` and `@hitbox/audit`. No database is touched: `tests/setup.ts`
sets dummy env vars because `@hitbox/shared` validates `process.env` at import
time and exits on failure.

69 tests across six suites, all passing.

## What is covered, and why those things

The tests were chosen by asking "which of these, if wrong, would be wrong
*quietly*?" — a broken route 500s and someone notices; a royalty that is 10%
wrong, or a webhook processed twice, does not.

### `packages/finance/tests/royalty-calculation.test.ts` (19)

The arithmetic, on its own, with no database and no Express in sight.

* **The document's worked example verbatim** — $100 gross, $25 COGS, 15% →
  $11.25 — asserted against the real code path rather than a reimplementation.
* `GROSS_REVENUE` basis ignores COGS; missing COGS is zero.
* **A below-cost sale floors at zero** rather than going negative. A negative
  accrual would net against unrelated sales and silently reduce a payout the
  artist has already been told about.
* Rounding is half-up to 2dp, and **1,000 accruals of $0.01 sum to exactly
  $10.00** — the decimal-arithmetic guarantee, stated as a test.
* Rule resolution: product beats collection beats artist beats organization;
  falls back down the chain; **picks the version in force at the moment of the
  claim, not the newest**, which is what makes an old order reproducible.
* `splitsOf`: the single-percentage fallback, multi-party configs, and a
  malformed split that names no payee being *dropped* rather than defaulted.
* `accrualKey` is stable per (claim, rule, payee) and differs per payee.

### `packages/finance/tests/royalty-accrual.service.test.ts` (10)

The accrual and reversal paths, against a fake ledger that **enforces the
UNIQUE constraint** — a collision returns null rather than throwing, exactly as
the real repository does. Testing idempotency against a fake that does not
enforce uniqueness would prove nothing.

* Accrues $11.25 at the claim, with the arithmetic snapshotted on the row.
* **The same claim processed twice accrues once.**
* No settled order → nothing accrued, no throw (a giveaway is ordinary).
* No rule in force → nothing accrued.
* The royalty expense is posted to the platform ledger, keyed.
* A two-way split writes two entries (`7.50` / `3.75`).
* **Reversal of an unpaid entry** marks it `REVERSED` and writes an adjustment
  pointing at it with `-11.25`.
* **Reversal of a paid entry** posts a negative clawback entry instead, status
  `ACCRUED`, so it nets off the next batch — and does *not* mark the original.
* An already-reversed entry is skipped.
* The expense is credited back so margin stops counting it.

### `packages/finance/tests/finance-access.test.ts` (12)

The RBAC rule, because what leaks when it is wrong is another party's revenue.

* Scope resolution for global / organization / own, strongest-wins.
* A caller with no `payment-royalty` grant is refused outright.
* **Read is not write**: a global reader cannot manage or override, and an
  org-scoped manage grant is not a platform-wide one.
* The filters: unrestricted for global, own-artist for own, org + managed
  artists for organization.
* **Fail-closed** — an own-scoped caller with no artist profile gets a filter
  matching nothing, not an empty filter matching everything.

### `packages/payments/tests/webhook-signature.test.ts` (11)

The security boundary of the whole module: this endpoint can mark any order
paid. Each test maps to a way the check could be wrong while still "working" in
development.

* A correct signature verifies, from a string and from a `Buffer`.
* **A body tampered by one character does not.**
* A different signing secret does not.
* A delivery older than the tolerance window is rejected — **and one too far in
  the future**, because rejecting only the past leaves a forged future timestamp
  valid indefinitely.
* Missing and malformed headers are rejected without throwing.
* Several `v1` values (a key rotation) verify if any matches.
* A signature of the wrong length does not crash the constant-time compare.

### `packages/payments/tests/webhook.service.test.ts` (8)

Ingestion, against a fake webhook table keyed by the provider's event id.

* A genuine delivery verifies, records and processes.
* **A replay is skipped, and settlement runs exactly once** — the document's
  stated requirement, asserted on the call count rather than on a status.
* An unsigned or wrongly-signed delivery is rejected **and nothing is written** —
  storing it would put attacker-controlled JSON in the replay queue.
* An unhandled event type is recorded and acknowledged, not rejected.
* **A failed delivery keeps its row with the error and rethrows**, so it lands
  in the replay queue rather than vanishing.
* A payload with no event id is refused.

### `packages/payments/tests/refund-workflow.test.ts` (9)

* The D4-35 path is allowed; **`REQUESTED → PROCESSED` is not**.
* Rejection is available at every stage before execution.
* `PROCESSED` and `REJECTED` are terminal and cannot be reopened.
* The 90-day quarantine on `DAMAGED` / `MISSING` / `TAMPERED`, and **no
  quarantine on `INTACT`** or on an uninspected return.

## What is not covered

Stated plainly, because a coverage claim is only useful if its edges are known.

**No integration tests.** Everything here is a unit test with fakes. The
end-to-end chain the document asks for — payment → accrual → refund → ledger
correction — needs a test database, and there is no harness for one in this
repo. The fakes do enforce the constraints that carry the guarantees (UNIQUE
keys return null, guarded updates return counts), so the logic *above* the
database is exercised; the database's own behaviour is not.

**No HTTP-level tests.** Controllers are thin (parse, resolve caller, call
service, shape JSON) and the services they call are tested, but no test drives a
route through Express.

**The payout sweep is untested.** `RoyaltyPayoutService.schedule` has the most
intricate logic in the module — threshold resolution, the guarded attach, the
count check that aborts a batch whose entries moved — and it is the piece most
worth testing next.

**Cross-currency reporting is untested end to end.** The summary is per-currency
by construction and never sums across, but nothing exercises a USD and an INR
order together.

See [coverage-matrix.md](coverage-matrix.md) for these alongside the rest of the
open items.
