# Tax & invoicing schema

The seven tables `@hitbox/tax` owns, in
`packages/tax/prisma/tax.prisma`, merged into the shared schema by
`pnpm db:merge` like every other module partial.

Two properties drive nearly every column, and both follow from the fact that a
tax authority may ask about a transaction years after it happened:

**Everything is snapshotted.** An invoice copies the rate, the classification
code, the unit price and HitBox's own registration numbers onto itself. A later
edit to the rate table, to the product, or to the company's GSTIN must never
change what an already-issued invoice says — that document has left the building
and been filed on a return.

**Nothing is deleted or edited.** An issued invoice moves to `VOID` or is
superseded by a `CORRECTED` one; a wrong tax figure is corrected by a
`TaxAdjustmentEntry` that references the original. Same append-only rule the
finance ledgers follow.

---

## Ownership map

| Table | Rows | Purpose |
| --- | --- | --- |
| `TaxConfiguration` | ~tens | The rate + HSN/SAC that applies to a product in a jurisdiction, versioned |
| `Invoice` | one per settled order | The statutory document |
| `InvoiceLineItem` | one per line | What GSTR-1 is actually read at |
| `InvoiceNumberSequence` | one per (country, FY) | The gap-free counter |
| `TaxReturnFiling` | one per return per period | GSTR-1/3B, state sales tax, Form 16A, 1099-NEC |
| `ArtistTaxDocument` | a few per artist | W-9, PAN, GST registration, issued certificates |
| `TaxAdjustmentEntry` | rare | Corrections to an issued tax figure |

Foreign keys **out** of this module: `Order`, `User`, `Organization`, `Product`,
`Artist`, `RoyaltyPayout`. Nothing points back in except the back-relations
those modules' partials declare.

---

## `TaxConfiguration`

The rate table. Versioned by `effectiveFrom`/`effectiveTo` rather than mutable,
for the same reason `RoyaltyRule` is: GST rates change by notification on a
date, and re-deriving an old invoice has to reproduce the rate actually charged.

| Column | Note |
| --- | --- |
| `productId` | **Nullable** — null is "the jurisdiction default". Products are the specific case. |
| `countryCode`, `stateCode` | `stateCode` is US-only; India is centrally rated. |
| `taxType` | `GST` \| `SALES_TAX` \| `EXEMPT`. Exempt is a real classification, not an absence — an exempt supply still appears on the invoice at 0%. |
| `taxRate` | **`Decimal(6,3)`**, not `(5,2)`. California is 8.625%, NYC 8.875%; rounding to 8.63% prints a rate that appears in no state rate table. |
| `hsnCode` / `sacCode` | Mandatory in practice for India, nullable at the column because the US has no equivalent. The DTO enforces it. |
| `exemptionReason` | Required when `taxType = EXEMPT`. |

`@@unique([productId, countryCode, stateCode, effectiveFrom])` — a second row
for the same target on the same day is a mistake, not a newer version.

---

## `Invoice`

One per order (`orderId` is unique, which is also what makes issue idempotent).

**Identity.** `invoiceNumber` unique; `fiscalYear` stored rather than re-derived
from `invoiceDate`, so a return can be assembled without re-implementing the
fiscal calendar in a query.

**Money.** `subtotal`, `taxAmount`, `totalAmount` as `Decimal(12,2)`; `taxRate`
as `Decimal(6,3)`. `hsnCode` is denormalised onto the header for the HSN-wise
summary GSTR-1 wants.

**Supplier snapshot** — `supplierName`, `supplierAddress`, `supplierGstin`,
`supplierPan`, `supplierEin`. Copied at issue rather than read from
configuration at render time: registrations get amended and offices move, and an
invoice must keep showing the details the customer received.

**Customer snapshot** — `customerName`, `customerEmail`, `customerAddress`,
`customerGstin`. Same reasoning; the address book entry may be edited or deleted.

**Pricing provenance** — `salesPriceSnapshot` is the unit price the invoice was
raised at (guide 8.1). `productCostId` is a plain `Uuid` with **no foreign
key**: the versioned `product_cost` table does not exist in this schema yet, and
an invoice must never be blocked from being issued by a pricing table it does
not own.

**The document** — `pdfStorageRef` is the S3 **key**, never a URL, exactly as
`MediaAsset.storageRef` is, so signed-URL policy stays a runtime decision.
`pdfSha256` is what proves the object in the bucket is still the document that
was issued. Both are nullable: the row is the statutory record and the PDF is a
projection of it.

**Lifecycle** — `ISSUED` \| `VOID` \| `CORRECTED`. There is deliberately **no
`DRAFT`**: a row is written only once the order is settled, because issuing a
number that may never be used would put a gap in the statutory series.
`supersedesInvoiceId` is a self-relation for the correction chain; the
superseded invoice is never deleted and both stay on the return trail.

---

## `InvoiceLineItem`

A separate table rather than a JSON column, for one concrete reason: **GSTR-1 is
filed with an HSN-wise breakdown.** The tax authority reads lines, not invoices,
and a JSON blob cannot be summed by HSN in SQL.

Every money column is a snapshot; nothing is recomputed on read. `productId` and
`skuId` are plain ids with no FK — the line must survive a product being
retired. `@@unique([invoiceId, position])` keeps the printed order stable;
`@@index([hsnCode])` is the classification summary's index.

---

## `InvoiceNumberSequence`

`(countryCode, fiscalYear) → lastNumber`. Four columns doing one job: making the
invoice series gap-free.

A Postgres `SEQUENCE` cannot — `nextval` is deliberately non-transactional, so a
rolled-back invoice burns a number and leaves a hole an auditor will ask about.
This row is locked and incremented inside the same transaction as the insert, so
a rolled-back invoice rolls back its number too.

The cost is that invoice creation serialises per (series, fiscal year). At
HitBox's volume that is nothing, and it is the correct trade: a gap in the
series is a compliance finding, a few milliseconds of lock contention is not.

---

## `TaxReturnFiling`

Covers two different things that happen to share a shape:

- **Returns HitBox files about itself** — `GSTR_1`, `GSTR_3B`,
  `STATE_SALES_TAX`. Built from every invoice in the period.
- **Information returns about an artist** — `FORM_16A`, `FORM_1099_NEC`. These
  carry `artistId` and `payoutId`.

`payoutId` is a **real FK to `RoyaltyPayout`**, and it is the control 8.3 of the
guide turns on: Form 16A and 1099-NEC report *paid* royalty income, so a filing
of either type must point at a payout that was approved and executed, never at a
ledger accrual. A filing referencing a payout that does not exist is a filing
that cannot be substantiated.

`@@unique([filingType, countryCode, stateCode, periodStart, artistId])` — one
filing per return per period per jurisdiction, and per artist for information
returns.

`documentStorageRef` is where a generated Form 16A / 1099-NEC PDF would live.
Not produced yet — the figures and the payout link exist, the certificate
document does not.

---

## `ArtistTaxDocument`

The most sensitive table in the module.

`documentStorageRef` points at a **private** key under
`tax-artist-documents/` — never a public prefix, reachable only through a
120-second presigned GET after a permission check.

`documentNumber` holds a **PAN or GSTIN**, which are business identifiers. It
deliberately does *not* hold an SSN or EIN: that number stays inside the W-9
PDF, which is access-controlled as a whole.

`backupWithholdingApplied` / `backupWithholdingRate` are denormalised onto the
row on purpose. The payout path asks "may this artist be paid without
withholding" and must get one answer, not have to interpret document status
itself. A new registration always starts withheld; the *review* is what clears
it — the safe default, because withholding on an artist who did file is a refund
at tax time, and not withholding on one who did not is an IRS penalty against
HitBox.

`@@unique([artistId, documentType, countryCode, status])` allows exactly one
live document of each type, which is why registering a replacement archives the
old one in the same transaction. Archiving rather than updating keeps the old
W-9 readable: HitBox has to show which document was on file when a payment was
made, not just the current one.

`@@index([expiresAt])` backs the sweep that raises "this artist's GST
registration lapses in 30 days" before a payout is blocked by it.

---

## `TaxAdjustmentEntry`

Mirrors finance's `AdjustmentEntry` exactly. The original invoice keeps its own
row and its own numbers; this records what changed, why, and who approved it.

`adjustmentAmount` is signed and **stored rather than derived**, so the trail
reads as a ledger. Negative is a refund of tax over-collected.

Always created `PENDING_APPROVAL`, and the approver must not be the person who
raised it — four-eyes on a statutory correction is not ceremony, it is the
control an audit looks for.

---

## Enums

`TaxType` · `TaxConfigurationStatus` · `InvoiceStatus` · `TaxFilingType` ·
`TaxFilingStatus` · `ArtistTaxDocumentType` · `ArtistTaxDocumentStatus` ·
`TaxAdjustmentType` · `TaxAdjustmentStatus`

All live in the module partial rather than `shared/database/prisma/enums.prisma`,
because no other module uses them — same rule the other partials follow.

---

## Back-relations added to other modules

Prisma needs the other side of every relation declared in the owning partial:

| Partial | Added |
| --- | --- |
| `orders/prisma/orders.prisma` | `Order.invoice Invoice?` |
| `users/prisma/users.prisma` | nine named `User` back-relations (buyer, and the createdBy/verifiedBy/approvedBy/filedBy actors) |
| `products/prisma/products.prisma` | `Product.taxConfigurations` |
| `artist/prisma/artist.prisma` | `Artist.artistTaxDocuments`, `Artist.taxReturnFilings` |
| `organizations/prisma/organizations.prisma` | `Organization.invoices` |
| `finance/prisma/finance.prisma` | `RoyaltyPayout.taxReturnFilings` |

---

## Migration

**Applied** on 2026-09-18 as `20260918000000_tax_invoicing_and_staff_invitations`, together with access-control's
`StaffInvitation` table.

```bash
pnpm db:merge && pnpm db:validate   # → The schema at prisma\schema.prisma is valid 🚀
pnpm --filter @hitbox/database db:deploy
```

The migration is **purely additive** — 10 `CREATE TYPE`s, 8 `CREATE TABLE`s,
their foreign keys and indexes, and not a single `DROP` or column change on an
existing table. The back-relations listed above are relation fields, which add
no columns, so no existing table is touched at all.

`prisma migrate diff` against the live database now reports an empty migration,
which is drift-free by definition.
