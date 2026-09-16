# Schema changes

Every database change made for the finance & revenue ledger, why it exists, and
how to apply it.

The migration is
`packages/shared/database/prisma/migrations/20260916120000_finance_revenue_ledger/`.

## How to apply it

```bash
pnpm db:validate
```

```bash
pnpm db:deploy
```

`db:validate` merges the module partials into the generated schema and checks
it; `db:deploy` applies pending migrations (this is the CI/production path —
`pnpm db:migrate` is the local one that would create a *new* migration from a
drifted schema, which is not what you want here since the migration already
exists).

Remember the golden rule from [../hitbox-architecture.md](../hitbox-architecture.md)
§8: **never edit `schema.prisma`**. It is generated from the per-module
partials by `merge-schema.mjs`. Every change below was made in a module's own
`prisma/*.prisma` file.

## Migration safety

Four columns were added `NOT NULL` to tables that already exist
(`RoyaltyLedgerEntry.accruedAt/basis/payeeType/status`,
`FinanceLedgerEntry.category`, `RefundRequest.currency/physicalReturnRequired/
reasonCode`). Prisma's generated SQL would have added them bare, which fails on
any table with rows in it.

The committed migration instead adds each one **with a default, backfills, then
drops the default**:

* `accrualKey` backfills from `id::text` — every pre-existing entry is distinct
  and none came from a repeatable trigger, so the row's own id is a correct
  idempotency key for it.
* `accruedAt` backfills from `createdAt`.
* `RefundRequest.currency` backfills from its order's currency rather than
  keeping the `'USD'` placeholder the column was created with.

The default is dropped afterwards so it does not silently become the
application's behaviour — a column that defaults to `ACCRUED` forever is a
column that will eventually be written without a status by accident.

---

## `packages/finance/prisma/finance.prisma`

### `RoyaltyRule` — extended

| Column | Why |
| --- | --- |
| `payoutThreshold` `Decimal(12,2)?` | "Accrue until $500, then pay" is a term of the artist's **deal**, not a platform constant. Null falls back to `ROYALTY_DEFAULT_PAYOUT_THRESHOLD`. |
| `payoutFrequency` `PayoutFrequency?` | Same reasoning for cadence: `WEEKLY` / `BIWEEKLY` / `MONTHLY` / `QUARTERLY`. |
| 4 indexes on `(scopeColumn, effectiveFrom)` | Rule resolution walks all four scope columns filtered by the effective window, on every accrual. |

Putting the threshold on the rule rather than in a global settings row also
means a renegotiated deal changes without rewriting the entries already accrued
under the old one — the rule is versioned by `effectiveFrom`, so the old row
keeps the old threshold.

### `RoyaltyLedgerEntry` — extended

| Column | Why |
| --- | --- |
| `skuId`, `claimId` (no FK) | What triggered the accrual. No foreign key so a revocation is never blocked by the ledger. |
| `accrualKey` **UNIQUE** | The duplicate-accrual guard. `claim:<claimId>:rule:<ruleId>:payee:<payeeId>`. |
| `payeeType`, `payeeArtistId`, `payeeOrganizationId` | Who is owed. An artist deal and a brand deal settle to different parties. |
| `basis`, `percentage`, `grossRevenue`, `costOfGoods`, `netProfit` | The arithmetic, snapshotted, so the figure stays checkable after the price table changes. |
| `status` `RoyaltyEntryStatus` | `ACCRUED → PENDING_PAYOUT → PAID`, plus `REVERSED`. |
| `payoutId` → `RoyaltyPayout` | Batch membership. |
| `accruedAt`, `paidAt` | The two timestamps a statement needs. |
| 5 indexes | Balance queries by payee+status+currency; order, claim and payout drill-downs. |

### `RoyaltyPayout` — new

One row per payout batch: payee, currency, amount, `entryCount`,
`thresholdApplied` (snapshotted so a later rule change does not rewrite why the
batch existed), `status` (`SCHEDULED → APPROVED → PAID`, or `FAILED` /
`CANCELLED`), `approvedById` (no FK — a payout record outlives the approver's
account), `gatewayPayoutRef`, `paidAt`, `failureReason`.

### `AdjustmentEntry` — new

The immutability principle, as a table. `targetType` + `targetId` is a
polymorphic pointer with **no foreign key**, deliberately: a correction must be
postable against a record in any module, and the correction trail must survive
the archival of what it corrects. `amountAdjustment` is **signed** — negative
reverses, positive posts a make-good. `reasonCode` is the machine-readable half
of the reason; the free-text `reason` is always required alongside it.

### `FinanceLedgerEntry` — extended

| Column | Why |
| --- | --- |
| `category` `FinanceCategory` | Separates revenue from the fee the gateway took, without a second table. Drives the revenue summary. |
| `postingKey` **UNIQUE?** | Idempotent posting: a settlement webhook delivered six times books revenue once. |
| `adjustsEntryId` | Correction chain, mirroring the royalty ledger. |
| 3 indexes | Order drill-down; category-over-time for the summary; plain time range. |

### New enums

`RoyaltyEntryStatus`, `RoyaltyPayeeType`, `PayoutFrequency`, `PayoutStatus`,
`AdjustmentTargetType`, `AdjustmentReason`, `FinanceCategory`.

---

## `packages/payments/prisma/payments.prisma`

### `PaymentTransaction` — extended

`settledAt` (distinct from `updatedAt`, which moves for a review note too), plus
indexes on `orderId`, `(status, createdAt)` and `gatewayRef` — the last one is
how a webhook finds the charge it is about.

### `RefundRequest` — extended

`reasonCode`, `currency`, `physicalReturnRequired`, `nfcTagCondition`,
`rejectionReason`, `processedAt`, `claimRevokedAt`, `resaleBlockedUntil`. Each
one is a step in the D4-35 workflow — see
[refunds-and-disputes.md](refunds-and-disputes.md).

### `DisputeCase` — new

Chargebacks. `gatewayCaseRef` is **UNIQUE**, so a redelivered dispute webhook
updates the existing case instead of opening a second one that would
double-count the loss. `evidenceDueBy` is a column rather than a note because
missing the network's deadline loses the case by default, and the queue sorts
by it.

### New enums

`RefundReason`, `NfcTagCondition`, `DisputeStatus`, `DisputeReason`.

---

## `packages/orders/prisma/orders.prisma`

### `Order` — extended

`claimId` + `claimedAt` (no FK). The decoupling of payment from ownership, made
queryable. Plus indexes on `(organizationId, placedAt)`, `(status, placedAt)`,
`skuId` and `claimId`.

### `InventoryReservation` — indexed

`(skuId, status)` for the availability check on every checkout, and
`(status, expiresAt)` for the expiry sweeper.

---

## `packages/organizations` and `packages/artist` — back-relations only

Prisma requires the opposite side of every relation. `Organization` and `Artist`
each gained `royaltyLedgerEntrys` (via a **named** relation, because both are
already a rule *scope* and are now also a *payee*, and Prisma needs the two
links disambiguated) and `royaltyPayouts`.

---

## Environment variables

Added to `packages/shared/config/env.ts`, all optional — a deployment that takes
no money needs none of them:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe's signing secret (`whsec_…`). **Without it the webhook route is not mounted at all** — an unverified payment webhook is a way to mark any order paid, so "no secret" must mean "no endpoint", not "an endpoint that trusts whatever arrives". |
| `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` | `300` | How far a delivery's timestamp may be from now. The window is what stops a captured delivery being replayed indefinitely. |
| `INVENTORY_HOLD_SECONDS` | `900` | How long a checkout holds a serialized unit. Long enough for a 3-D Secure challenge, short enough that an abandoned basket does not keep a one-of-500 unit off sale for an hour. |

Gateway **API keys are deliberately not declared here**. They live in the
secrets manager; `PaymentGatewayConfig.credentialsRef` stores only a pointer,
and the DTO refuses a value that looks like an actual key (`sk_…`, `whsec_…`)
for exactly the reason that mistake is easy to make.
