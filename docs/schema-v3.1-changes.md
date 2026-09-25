# Schema v3.1 — What Changed, and What Did Not

> One migration, `20260925000000_v31_nfc_tag_master_cogs_exceptions_and_approvals`.
>
> **No REST route, request body or response body changed**, with one named
> exception in §7. If you are integrating against the API, §1 and §7 are the
> only sections that can affect you.
>
> Related: [database-architecture.md](database-architecture.md) (module
> ownership and the partial-schema layout), [admin/](admin/admin-api-reference.md).

---

## 1. The headline: nothing was renamed in the database

Seven Prisma models and one enum were renamed. **Not one table or column was.**
Every rename is carried by `@@map` / `@map`, so the physical schema is byte-for-byte
what it was and every existing row, index, foreign key and SQL query still works.

| Prisma name before | Prisma name now | Table / column, unchanged |
|---|---|---|
| `Product` | `Drop` | `Product` |
| `ProductVariant` | `DropVariant` | `ProductVariant` |
| `ProductPrice` | `DropPrice` | `ProductPrice` |
| `ProductImage` | `DropImage` | `ProductImage` |
| `ProductClaim` | `SkuClaim` | `ProductClaim` |
| `ProductHistory` | `SkuHistory` | `ProductHistory` |
| enum `ProductPriceStatus` | `DropPriceStatus` | `ProductPriceStatus` |
| `DropPrice.productId` | `DropPrice.dropId` | column `productId` |
| `Invoice.productCostId` | `Invoice.dropPriceId` | column `productCostId` |

Relation fields moved with them: `product` → `drop`, `products` → `drops`,
`productImages` → `dropImages`, `productVariants` → `dropVariants`,
`productPrices` → `dropPrices`, `productClaims` → `skuClaims`,
`productHistorys` → `skuHistories`. Relation fields have no column, so the
database does not know they exist.

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
  `productId_assetId`) are part of the Prisma Client API. `DropPrice` is the one
  exception, because its unique key was being changed anyway.
- **REST routes** (`/api/v1/admin/products/…`), **DTO fields**, **response body
  keys** (`product`, `counts.products`, `productCode`, `productName`) and every
  other public contract. A rename of an internal model is not a reason to break
  a client.

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

Backfilling `NfcTag` from them is an open question (§8).

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
no-foreign-key rule. It is only visible to callers with operator-grade tax
access, and it pointed at a `product_cost` table that never landed; it now names
the `DropPrice` row that priced the invoice. Buyer and artist views of an
invoice are untouched.

---

## 8. Open questions — these need a decision, not a guess

1. **What status should existing `AdjustmentEntry` rows have?** They defaulted
   to `PENDING_APPROVAL`, which reads as "somebody still has to approve these".
   If they should be `EXECUTED`, that is a one-line update — but it is a
   statement about money that already moved, so finance should make it, not us.
2. **When does `SupplyBatch.dropId` become required?** It is nullable with a
   `// TODO: make required after backfill (target: String)` marker. Existing
   batches predate the per-drop model and have no drop to point at.
3. **When is `NfcTag` backfilled from the deprecated `Sku` columns, and who
   flips the reads?** Until then there are two sources of truth for a chip's
   state, and only the `Sku` one is written. The inventory-edit endpoints in
   [admin/sku-inventory-management.md](admin/sku-inventory-management.md) still
   write the `Sku` columns exclusively.

---

## 9. Verification

| Check | Result |
|---|---|
| `db:merge` | regenerates `schema.prisma`, 68 models |
| `prisma validate` / `format` / `generate` | pass |
| Migration SQL | `CREATE TYPE` ×7, `ALTER TYPE … ADD VALUE` ×3, `CREATE TABLE` ×4, 11 `ALTER TABLE` statements adding 42 columns, `CREATE INDEX` ×3 + `CREATE UNIQUE INDEX` ×7, `ADD CONSTRAINT … FOREIGN KEY` ×10, and **one** `DROP INDEX` — the §4 unique swap. Zero `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN` or `RENAME` |
| `migrate diff` after apply | *"This is an empty migration"* — zero drift |
| Typecheck | clean across all 30 packages and `apps/backend` |
| Tests | 842 pass |
| Grep | no `prisma.product*`, `Prisma.Product*`, `ProductPriceStatus` or `productCostId` left in application code |

The migration was applied to the **dev** Neon branch. Production still needs
`pnpm db:deploy`.
