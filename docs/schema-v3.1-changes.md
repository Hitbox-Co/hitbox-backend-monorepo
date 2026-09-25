# Schema v3.1 — What Changed, and What Did Not

> Two migrations:
> `20260925000000_v31_nfc_tag_master_cogs_exceptions_and_approvals` (additive)
> and `20260925120000_v311_rename_product_tables_to_drop` (renames).
>
> **No REST route, request body or response body changed**, with one named
> exception in §7. If you integrate against the HTTP API, §1 and §7 are the only
> sections that can affect you. If you read the **database** directly, §1 is a
> breaking change and you have to read it.
>
> Related: [database-architecture.md](database-architecture.md) (module
> ownership and the partial-schema layout), [admin/](admin/admin-api-reference.md).

---

## 1. Six tables and one enum type were renamed

`Drop` is what the business calls this record everywhere else. The old name read
as "a physical thing", which is the `Sku` — one row per object in somebody's
hands. Conflating the two is the most common integration mistake in this
codebase, and the model names were helping the confusion along.

| Before | Now |
|---|---|
| `Product` | `Drop` |
| `ProductVariant` | `DropVariant` |
| `ProductPrice` | `DropPrice` |
| `ProductImage` | `DropImage` |
| `ProductClaim` | `SkuClaim` |
| `ProductHistory` | `SkuHistory` |
| enum `ProductPriceStatus` | `DropPriceStatus` |
| `ProductPrice.productId` | `DropPrice.dropId` |
| `Invoice.productCostId` | `Invoice.dropPriceId` |

**This is now true of the database as well as of Prisma.** It landed in two
steps, which matters if you are reading an older commit:

- **v3.1** renamed the Prisma models only, keeping the physical names behind
  `@@map` / `@map`.
- **v3.1.1** dropped those aliases and renamed the tables, the enum type and the
  two columns for real. There is no `@@map` left in the schema — every Prisma
  name *is* the database name.

Relation fields moved with the models: `product` → `drop`, `products` →
`drops`, `productImages` → `dropImages`, `productVariants` → `dropVariants`,
`productPrices` → `dropPrices`, `productClaims` → `skuClaims`,
`productHistorys` → `skuHistories`. Those have no column, so they never reached
the database either way.

### ⚠️ What this breaks

Anything addressing these tables **by name from outside Prisma**: raw SQL, saved
queries, BI tools, dashboards, external readers, a replica's mapping. Inside
this repo the three raw-SQL sites were updated in the same change
(`dashboard.repository.ts` ×2, `backfill-v31.ts` ×1); outside it, nobody can
find them for you.

Nothing else breaks. `ALTER TABLE … RENAME` is a catalog operation: no rows are
read or copied, it is constant time regardless of table size, and every row,
index, constraint, foreign key and default survives untouched. Row counts before
and after were identical — 18 / 36 / 37 / 13 / 60 / 60.

### How the migration was written, and why by hand

**`prisma migrate` cannot express a rename.** Given a model renamed from
`Product` to `Drop` it emits `DROP TABLE "Product"` + `CREATE TABLE "Drop"`,
which would destroy every row in six tables. The v3.1.1 migration is therefore
hand-written `ALTER … RENAME`, and it renames three kinds of thing:

1. the six tables, the enum type and the two columns;
2. **every constraint and index name on them.** Postgres keeps the old names
   after a table rename, so `Drop` would still carry `Product_pkey`. Prisma
   derives expected names from the table, so leaving them means permanent
   drift: every `migrate diff` would want to rename them, and the next
   `migrate dev` would try to drop and recreate them. A `DO` block prefix-swaps
   all 68 of them, because a hand-written list of 68 names is a place to make a
   typo;
3. the three names that carry the renamed *column* as well as the table —
   `DropPrice_dropId_fkey` and friends.

The proof it was complete: `migrate diff` against the live database afterwards
returns *"This is an empty migration"*. Prisma finds nothing it would change,
down to every constraint and index name.

**"Drop" is what everyone already calls it.** The old name read as "a physical
thing", which is the `Sku` — one row per object in somebody's hands. Conflating
the two is the most common integration mistake in this codebase, and the model
names were helping the confusion along.

### What was deliberately *not* renamed

- **`Sku.productId`, `Order.productId`, `TaxConfiguration.productId`, …** — the
  scalar FKs on other modules' tables. The rename brief covers models and
  relation fields; renaming these too would churn compound keys through a dozen
  modules for no behavioural gain.
- **`DropVariant.productId` and `DropImage.productId`** — same reason, plus
  their compound uniques (`productId_optionName_optionValue`,
  `productId_assetId`) are part of the Prisma Client API. `DropPrice.dropId` is
  the exception, because its unique key was being rebuilt anyway (§4).
  These are consistent between Prisma and the database, which is the property
  that actually matters.
- **REST routes** (`/api/v1/admin/products/…`), **DTO fields**, **response body
  keys** (`product`, `counts.products`, `productCode`, `productName`) and every
  other public contract. A rename of an internal model is not a reason to break
  a client. Where a codemod reached one of these by accident it was put back —
  `markets` still returns `usage.productPrices` and `MARKETS_IN_USE` still
  carries `details.productPrices`, now read from the renamed relation.

---

## 2. NFC tags became rows of their own

A chip used to be five columns on `Sku`. It is now `NfcTag`, because a chip has
a life the item does not:

- it is **QC'd by the vendor before it is bound** to anything (`qcStatus`,
  `qcReportedAt`, `qcNotes`);
- it can be **replaced while the item keeps its history** — `Sku.currentNfcTag`
  is the chip in the item now, `Sku.nfcTagHistory` is every chip it has carried;
- its **UID must stay unique for ever**, even after retirement, which a column
  on a row that gets re-tagged cannot express;
- **keys and the tap counter belong to the chip**, not the object.

UIDs are never stored in the clear: `tagUidHash` is an HMAC-SHA256 lookup key
and `tagUidEncrypted` is AES-256-GCM with the key in KMS. `keyReference` is a
KMS pointer and never a key.

`NfcVerification` is the append-only log of every tap. The single-use claim
token stays on `Sku.claimToken` — it authorises a claim of *that unit* and has
to survive a chip replacement.

### The old columns are still there and still work

`Sku.tagId`, `provisioningBatchId`, `tagLifecycleState`, `lastTapCounter` and
`tamperStatus` are untouched, still written and still read. They carry a
`/// @deprecated — moving to NfcTag (SD-7)` note and nothing else. **No data was
migrated and no code that reads them was changed** — including the whole SKU
inventory surface in
[admin/sku-inventory-management.md](admin/sku-inventory-management.md), which
continues to edit the `Sku` columns.

`NfcTag` is mirrored from them by the backfill in §8; **nothing reads it yet**, and the `Sku` columns remain the ones that are written.

---

## 3. New tables

| Table | Module | What it is |
|---|---|---|
| `NfcTag` | skus | One row per physical chip — §2 |
| `NfcVerification` | skus | One row per tap verification |
| `CogsReconciliation` | finance | Monthly COGS variance review per drop |
| `ExceptionCase` | platform | Ops Console exception queue |

`CogsReconciliation` follows the immutability rule the finance ledgers already
follow: the variance is not corrected by rewriting history, it is recorded with
`newCost` + `effectiveFromDate` going forward, with a reviewer and an approver
on the row.

`ExceptionCase` uses a `referenceType` + `referenceId` polymorphic pointer with
**no** foreign key, deliberately — an exception has to be raiseable against a
record in any module and must survive the archival of whatever it points at.

68 models total, up from 64.

---

## 4. `DropPrice` is versioned now — the one behavioural change

This is the change most worth reading carefully.

**Before:** `@@unique([productId, variantId, marketId])` meant a drop/variant/market
triple could hold exactly one price row, and "the price" was that row.

**Now:** `@@unique([dropId, variantId, marketId, effectiveFrom])`, plus
`effectiveFrom` (defaulting to `now()`) and a nullable `effectiveTo`. The triple
can hold its whole price history.

A unique index cannot express "at most one *open* row", so the invariant that
used to be structural is now a **query condition**:

```ts
where: {
  effectiveFrom: { lte: now },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
}
```

Every read that meant "the price" now says so. Three call sites were changed:

| Where | What it does now |
|---|---|
| [product.repository.ts](../packages/products/src/repository/product.repository.ts) `ProductRepository.currentPrice()` | the shared where-clause; applied to `listPrices`, `findPrice`, `countPrices`, and both halves of `writePrices` |
| `writePrices` | the replace-mode delete and the "which rows exist" read are both confined to currently-in-force rows, so a superseded row is never updated in place |
| [order-write.repository.ts](../packages/orders/src/repository/order-write.repository.ts) checkout price lookup | picks the in-force row, ordered `effectiveFrom desc` |

**Nothing changes today.** Every existing row got `effectiveFrom = <migration
time>` and `effectiveTo = NULL`, so every one of them satisfies the condition
and the results are identical to before. The behaviour only diverges once
something starts writing history — which nothing does yet.

**Prisma Client API note:** the compound key argument is renamed
`dropId_variantId_marketId` → `dropId_variantId_marketId_effectiveFrom`. It has
**no call sites** — pricing never used it, because `variantId` is nullable and
Postgres NULLs never collide in a unique index, so the old three-column unique
did not actually prevent two base prices for the same market either. That is
still enforced by hand in `writePrices` and by the service rejecting duplicates
in the payload.

---

## 5. Approval trails

| Table | Added |
|---|---|
| `AdjustmentEntry` | `status` (`AdjustmentStatus`, default `PENDING_APPROVAL`), `approvedById`, `approvedAt` |
| `RoyaltyPayout` | `payoutPeriodStart`/`End`, `approvalReason`, `transferInitiatedById`/`At` |
| `DropPrice` | `approvedById`, `approvedAt` (alongside §4) |
| `CogsReconciliation` | reviewer and approver, from the start |

⚠️ **Existing `AdjustmentEntry` rows now read `PENDING_APPROVAL`, and that is
almost certainly wrong for them** — they were posted before an approval step
existed and are in fact executed. No backfill is written, on purpose; see §8.

`RoyaltyPayout` now separates *approving* a payout from *instructing the
transfer*, because those are two acts and often two people.

---

## 6. Ledger signing

`BlockchainLedger` gains `hashVersion` (default `1`), `platformSignature`,
`signingKeyVersion`, `actorType` (new `ActorType` enum, default `SYSTEM`),
`actorRef`, `reason`, `occurredAt` and `nfcTagId`.

The signatures already on the row prove the *counterparties* consented. These
prove the *platform* wrote it: without them a chain is only as trustworthy as
the database it sits in, and "the hash matches" says nothing about who computed
it.

**The hash computation is unchanged.** The existing writer still emits
`hashVersion: 1`; a later algorithm bumps it and verification dispatches on it
rather than assuming.

`LedgerTxType` gains `REVOKE` and `REISSUE`, **appended** — an enum value's
position is part of the physical type in Postgres, so reordering is the one edit
to an enum that is not additive. There are no exhaustive `switch` statements or
`Record<LedgerTxType, …>` maps over this enum in the codebase (`txType` is only
ever passed through as a value), so nothing needed a new branch.

`SupplyItemType` gains `COLLECTIBLE`, appended for the same reason.

---

## 7. Smaller additions

| Table | Added |
|---|---|
| `Drop` | `publishAt` — the *scheduled* visibility, as distinct from `publishedAt`, which records when it actually happened |
| `Order` | `paidAt` — revenue is recognised on this, not on `placedAt` |
| `Vendor` | `legalName`, `country` (ISO alpha-2), `contactName`, `contactPhone`, `notes`, `updatedAt` |
| `SupplyBatch` | `dropId`, `batchDate`, `status` (`SupplyBatchStatus`), `rowsReceived`/`Accepted`/`Rejected`, `vendorInvoiceRef`, `validationReportRef`, `updatedAt` |
| `Sku` | `supplyBatchId`, `currentNfcTagId` |
| `RolePermission` | `requiresReason` — for the grants where "who did it" is not enough |
| `RoyaltyLedgerEntry` | `provenanceLedgerId` — a plain id with no FK, exactly like `skuId` and `claimId` beside it |
| `SupportCase` | `nfcTagId` (+ relation); `tagId` kept and marked `@deprecated` |

### The one public shape that changed

`GET /api/v1/admin/tax/invoices/:id` — the **operator-only** block renames
`productCostId` to `dropPriceId`. Same value, same nullable UUID, same
no-foreign-key rule — the column behind it was renamed to match in v3.1.1. It is
only visible to callers with operator-grade tax access, and it pointed at a
`product_cost` table that never landed; it now names the `DropPrice` row that
priced the invoice. Buyer and artist views of an invoice are untouched.

---

## 8. The data backfill

```bash
pnpm db:deploy          # the migration
pnpm db:backfill:v31    # then this
```

An additive migration can only give an existing row a **column default**, and
for several of the new columns that default is mechanically correct and
factually wrong. `BlockchainLedger.occurredAt` defaulting to `now()` says a
claim from July happened on the day the migration ran — which is exactly the
sort of thing a provenance chain must not say.

[backfill-v31.ts](../packages/shared/database/prisma/backfill-v31.ts) repairs
those and populates the four new tables. It is **idempotent** — Part A is scoped
to rows that existed at `_prisma_migrations.finished_at`, so a re-run touches
nothing and rows written afterwards are never rewritten — and **additive**:
nothing is deleted, and `Sku`'s deprecated tag columns are read and left exactly
as they are.

### Part A — defaults that were wrong for historical rows

| Column | Was | Now |
|---|---|---|
| `BlockchainLedger.occurredAt` | migration time | `createdAt` |
| `DropPrice.effectiveFrom` | migration time | `createdAt`, so a price has been in force since it was written |
| `SupplyBatch.batchDate` / `status` / `rows*` / `updatedAt` | today / `UPLOADED` / `0` | `receivedAt` / `ACCEPTED` / `quantity` |
| `Vendor.updatedAt` | migration time | `createdAt` — nothing has edited them |
| `Order.paidAt` | `NULL` | the gateway's `PaymentTransaction.settledAt`, else `placedAt`. Skips `PENDING_PAYMENT` and `CANCELLED`, which were never paid |

### Part B — the new tables, from the data already there

`NfcTag` is built from the units carrying a tag on the deprecated columns.
`NfcTag.supplyBatchId` is required and the only link available is
`Sku.provisioningBatchId` matched against `SupplyBatch.batchRef`; a unit whose
reference resolves to nothing is **skipped and reported**, never attached to an
arbitrary consignment. `Sku.currentNfcTagId` and `Sku.supplyBatchId` are then
linked.

`NfcVerification` reconstructs one row per tap `lastTapCounter` already claims
happened, so the counter and the log agree — which is what anything reading both
will assume.

`CogsReconciliation` and `ExceptionCase` get a small representative set pointed
at real drops, claims, orders and ledger rows.

> ### The dev key, stated plainly
>
> `tagUidHash` and `tagUidEncrypted` are real HMAC-SHA256 and AES-256-GCM,
> computed from a constant in the script. That is fine for a demo database and
> **is not a production backfill** — production needs the KMS key. Every row
> this script writes carries `keyReference: "dev-local:v1"`, so it can never be
> mistaken for one written against a real key.

### What it did on the dev branch

| | |
|---|---|
| `BlockchainLedger.occurredAt` | 120 of 120 repaired |
| `DropPrice.effectiveFrom` | 37 of 37 repaired; all 37 still resolve as the current price |
| `SupplyBatch` | 2 rows → `ACCEPTED`, 5000 / 1200 rows received |
| `Vendor.updatedAt` | 2 rows |
| `Order.paidAt` | 48 of 60 — the 12 left null are `PENDING_PAYMENT` and `CANCELLED` |
| `NfcTag` | 100, one per tagged unit, all linked and all resolving to `NT-2026-014` |
| `NfcVerification` | 355 — `lastTapCounter` matches the row count for **every** tag |
| `CogsReconciliation` / `ExceptionCase` | 12 / 5 |

A second run reported `0 row(s)` for every Part A repair and created no new
rows, which is the idempotency claim demonstrated rather than asserted.

### If you re-seed

`db:seed:demo` wipes and re-creates every business row, and two of the new
tables would have blocked it: `CogsReconciliation.dropId` and
`NfcTag.supplyBatchId` are `ON DELETE RESTRICT`. Both seeds now clear the v3.1
tables in the right order, so the teardown still works — but a re-seed drops
everything this backfill wrote, so **run `db:backfill:v31` again afterwards**.

---

## 9. Open questions — these need a decision, not a guess

1. **What status should existing `AdjustmentEntry` rows have?** They default to
   `PENDING_APPROVAL`, which reads as "somebody still has to approve these". The
   backfill deliberately does **not** touch them — it is a statement about money
   that already moved, so finance should make it. *(Moot on the dev branch: it
   has no `AdjustmentEntry` rows. It will not be moot in production.)*
2. **When does `SupplyBatch.dropId` become required?** Still nullable, with a
   `// TODO: make required after backfill (target: String)` marker. The existing
   consignments predate the per-drop model and have no drop to point at, so the
   backfill leaves them null rather than inventing an attribution.
3. **Who flips the reads onto `NfcTag`, and when?** The dev branch now has both
   representations and they agree, but **only the `Sku` columns are written** —
   the inventory-edit endpoints in
   [admin/sku-inventory-management.md](admin/sku-inventory-management.md) still
   write those exclusively, so the two will drift the moment somebody edits a
   tag. Production also needs the real KMS key before any backfill there.

---

## 10. Verification

| Check | Result |
|---|---|
| `db:merge` | regenerates `schema.prisma`, 68 models |
| `prisma validate` / `format` / `generate` | pass |
| Migration SQL | `CREATE TYPE` ×7, `ALTER TYPE … ADD VALUE` ×3, `CREATE TABLE` ×4, 11 `ALTER TABLE` statements adding 42 columns, `CREATE INDEX` ×3 + `CREATE UNIQUE INDEX` ×7, `ADD CONSTRAINT … FOREIGN KEY` ×10, and **one** `DROP INDEX` — the §4 unique swap. Zero `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN` or `RENAME` |
| `migrate diff` after apply | *"This is an empty migration"* — zero drift |
| Typecheck | clean across all 30 packages and `apps/backend` |
| Tests | 842 pass |
| Grep | no `prisma.product*`, `Prisma.Product*`, `ProductPriceStatus` or `productCostId` left in application code |
| Rename migration | hand-written `ALTER … RENAME` only; zero `DROP`, `DELETE` or `TRUNCATE` |
| Row counts across the rename | identical: `Drop` 18, `DropVariant` 36, `DropPrice` 37, `DropImage` 13, `SkuClaim` 60, `SkuHistory` 60 |
| Stale names in the database | none — no table, constraint or index still begins `Product`, and `ProductPriceStatus` no longer exists as a type |
| Live smoke test | `drop` → `dropPrices` / `dropVariants` / `dropImages` / `_count.skuClaims`, `skuClaim.drop`, `skuHistory.sku.drop` and `invoice.dropPriceId` all query successfully |

Applied to the **dev** Neon branch (`ep-blue-brook-ax6p9j8t` / `neondb`):
both migrations, then `pnpm db:backfill:v31`. Production needs the same three,
in that order — and the backfill's tag crypto needs the real KMS key first
(§8).

Before running the rename migration anywhere else, find the readers. Every
consumer of these tables that is not this Prisma client — a BI dashboard, a
saved query, an ETL job, a read replica's mapping — breaks at the moment it
runs, and no amount of care inside this repo can detect them.
