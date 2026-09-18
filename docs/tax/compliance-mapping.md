# Compliance guide → implementation

Section-by-section index from the **HitBox Tax & Invoicing Compliance Guide
v1.1** (2026-09-15, Jameela / Orup) to what was actually built — and, where
something was not built, why.

Legend: ✅ implemented · 🟡 partial · ❌ not built · ⬜ out of this module's scope

---

## Part 1 — India

|  | Requirement | Status | Where |
| --- | --- | --- | --- |
| 1.1 | GST 12% on physical collectibles, 18% premium, digital 0–5% | ✅ | `TaxConfiguration`, seeded per product/jurisdiction. Rates are data, not code — `GST_RATE_COLLECTIBLES` etc. are the documented defaults. |
| 1.1 | `GST = Sale Price × rate`; ₹2,000 @ 12% = ₹240, total ₹2,240 | ✅ | `domain/money.ts` `taxOn()`, pinned by `money.test.ts` |
| 1.2 | TDS 30% (s.194O) on artist royalty | 🟡 | The **rate and arithmetic** live here (`TDS_RATE_ROYALTY`, `form16aPreview`). The **deduction** is finance's payout path. |
| 1.2 | Form 16A issued quarterly, reconciling to *approved, paid* payouts | 🟡 | Figures + payout gate ✅ (`TaxFilingService`, `TaxReturnFiling.payoutId`). Certificate **PDF** ❌. |
| 1.3 | HSN 9706 for collectibles; SAC 998361 marketplace, 998999 digital | ✅ | `HSN_COLLECTIBLES`, `SAC_MARKETPLACE_SERVICE`, `SAC_DIGITAL_CONTENT`; stored per rate row and per invoice line |
| 1.3 | Every GST invoice **must** carry an HSN/SAC code | ✅ | Enforced twice: the DTO rejects an Indian rate without one, and the renderer refuses to draw an Indian invoice whose line lacks one |
| 1.4 | Invoice issued before or at the time of supply | ✅ | Issued on `payments.order.settled` — see [invoice-generation.md 2](invoice-generation.md#2-when-an-invoice-is-issued) |
| 1.4 | Unique, sequential invoice number per fiscal year | ✅ | `InvoiceNumberSequence`, gap-free by transaction |
| 1.4 | All eight mandatory fields | ✅ | `assertRenderable()` refuses to draw a deficient Indian invoice |
| 1.4 | Unit price from the versioned sales price, never COGS | 🟡 | `salesPriceSnapshot` ✅ and COGS never reaches the document ✅; `productCostId` is a nullable column awaiting the `product_cost` table |
| 1.4 | Signature / authorised stamp | ✅ | Authorised-signatory box, marked digitally issued |
| 1.5 | GSTR-1 / GSTR-3B data, HSN-wise breakdown, due dates | ✅ (data) / ❌ (filing) | `GET /admin/tax/reports/indirect-tax` + `/export`; `filingDueDate()` derives the 11th/20th. Filing to the GST portal is done by hand and its ARN recorded. |

---

## Part 2 — United States

|  | Requirement | Status | Where |
| --- | --- | --- | --- |
| 2.1 | State sales tax by nexus; $25 @ 8.625% = $2.16, total $27.16 | ✅ | `TaxConfiguration` per `(country, state)`, pinned by test |
| 2.1 | Rates vary by county | ✅ | `Decimal(6,3)` — see below |
| 2.2 | 1099-NEC, $600 threshold, Box 1 sums *paid* royalties | ✅ (figures) / ❌ (form) | `form1099Preview` + `FORM_1099_NEC_THRESHOLD_USD`; the PDF is not generated |
| 2.2 | W-9 on file **before** first payment | ✅ | `ArtistTaxDocument` + `withholdingStatus()`, consumed by finance through `taxModule.withholding` |
| 2.2 | 24% backup withholding when no W-9 | ✅ | `US_BACKUP_WITHHOLDING_RATE`, denormalised onto the document row |
| 2.2 | Workflow steps 1–7 (onboarding → IRS filing) | 🟡 | Steps 1–4 ✅ (collect, track, verify, compute). Steps 5–7 (mail, FIRE, Form 1096) ❌ — done by hand. |
| 2.3 | US invoice best-practice fields | ✅ | Same renderer; no HSN column, EIN instead of GSTIN |
| 2.3 | Unit price from the sales-price snapshot | 🟡 | As 1.4 |
| 2.4 | Multi-state nexus registration and filing cadence | 🟡 | `TaxReturnFiling` models a `STATE_SALES_TAX` return per state per quarter; the registration register itself is not modelled |

---

## Part 3 — Database extensions

The guide proposes five tables and one extension. What was built maps closely,
with three deliberate differences.

| Guide table | Built as | Difference |
| --- | --- | --- |
| `tax_configuration` | `TaxConfiguration` | `tax_rate` widened to `Decimal(6,3)` — see below |
| `invoice_master` | `Invoice` | Split: line detail moved to `InvoiceLineItem` — see below |
| — | `InvoiceLineItem` | **Added.** GSTR-1 is filed with an HSN-wise breakdown; a JSON blob cannot be summed by HSN in SQL |
| — | `InvoiceNumberSequence` | **Added.** The guide requires a gap-free series but does not say how; a Postgres sequence cannot provide one |
| `tax_return_filing` | `TaxReturnFiling` | `payout_approval_queue_id` → `payoutId`, a real FK to the existing `RoyaltyPayout` — see 8 |
| `artist_tax_documents` | `ArtistTaxDocument` | Adds `backupWithholdingApplied/Rate`, which the guide puts on `artist_tax_compliance` |
| `tax_adjustment_entry` | `TaxAdjustmentEntry` | As specified |
| `artist_tax_compliance` (3.6 extension) | ❌ not extended | See below |

### `Decimal(5,2)` → `Decimal(6,3)` on every rate

The guide specifies `NUMERIC(5,2)`. That cannot hold 8.625% — the exact figure
the guide itself uses in its own 2.1 worked example. US combined
state+county+district rates routinely carry a third decimal (California 8.625%,
New York City 8.875%), and storing 8.63% would print a rate on a statutory
document that the tax authority's own rate table does not contain. The tax
*amount* stays `Decimal(12,2)`.

### Line items split out of `invoice_master`

The guide's 4.1 step 4 describes line items but 3.2 gives `invoice_master` a
single `hsn_code` and no line table. GSTR-1 table 12 is an HSN-wise summary of
**lines**, so the breakdown has to be queryable. `Invoice.hsnCode` is kept as a
denormalised header value for the common single-code invoice.

### `artist_tax_compliance` not extended

3.6 proposes adding GSTIN, PAN, W-9 URL, state tax id and withholding flags to
an existing `artist_tax_compliance` table. **There is no such table in this
schema.** Rather than create one to extend it, the same facts live on
`ArtistTaxDocument`, one row per document, which is a better fit anyway: it
keeps document history (which W-9 was on file when a payment was made), carries
its own verification state, and does not mix a document register with a
per-tax-year compliance summary. If a per-year summary is later wanted, it joins
to these rows.

---

## Part 4 — Invoicing workflow

| Step | 4.1 (India) / 4.2 (US) | Status |
| --- | --- | --- |
| 1 | Order confirmed & payment received | ✅ `payments.order.settled` |
| 2 | Tax lookup from `tax_configuration` by state | ✅ `resolveTaxConfiguration`, most-specific-first |
| 3 | Invoice created automatically, number + HSN + rate + snapshot | ✅ |
| 4 | Row in `invoice_master`, **PDF stored in S3** | ✅ — [s3-storage.md](s3-storage.md) |
| 4 | Customer receives invoice by e-mail within 24 h | ❌ `Invoice.deliveredAt` exists for it; no mailer wired |
| 5 | Tax calculation | ✅ |
| 6 | GSTR-1 / state return reporting | ✅ data, ❌ submission |

---

## Part 6 — Roadmap

| Phase | Status |
| --- | --- |
| 1 — Foundation (tables, HSN codes, `invoice_master`) | ✅ schema written, validated and migrated |
| 2 — Invoice generation (logic, PDF template, numbering) | ✅ · e-mail delivery ❌ |
| 3 — Tax filing (`tax_return_filing`, GSTR-1 export, state report, dashboard) | 🟡 table + export data ✅; dashboard ⬜ (belongs in `@hitbox/dashboard`) |
| 4 — Document management (`artist_tax_documents`, W-9 upload, expiry alerts) | ✅ table, registration, review, expiry sweep · alert delivery ⬜ (`@hitbox/notifications`) |
| 5 — Testing & compliance | 🟡 72 unit tests over the arithmetic, numbering, key safety, access and renderer; integration and load tests ❌ |
| 6 — Deployment | ⬜ |

---

## Part 8 — the 2026-09-15 business-logic changes

The three ratified changes, and how each lands here.

### 1. COGS & Sales Price entered manually, stored in versioned `product_cost`

The invoice's tax base is `salesPriceSnapshot`, copied at issue so a later
re-versioning of the drop's pricing never retroactively changes an already-issued
invoice — exactly what 8.1 asks for.

**COGS never reaches the invoice.** There is no COGS field anywhere in this
module's document model, and the port tax declares over orders
(`IInvoiceableOrderSource`) does not expose one. That is structural, not a
convention someone has to remember: the type simply has no such field to print.

`Invoice.productCostId` is a nullable `Uuid` with **no foreign key**, waiting for
the `product_cost` table. No FK because that table does not exist in this schema
yet and an invoice must never be blocked from being issued by a pricing table it
does not own. When it lands, the column is populated at issue and nothing else
changes.

### 2. Artist-level royalty rate, fixed at artist creation

⬜ **Finance's, not tax's.** `Artist.royalty_rate_percent` and the
`artist.set_royalty_rate` permission belong to the artist/finance side. This
module consumes the *result* — the payout amount — and never the rate.

### 3. Quarterly payout approval workflow

This is the change with the most consequence for tax, and 8.3 says so: *"every
'accrued royalties' example in Parts 1–2 that predates 2026-09-15 should now be
read as 'approved, paid royalties'."*

Implemented as a hard gate rather than a convention:

- `IPayoutLookup` — the port tax declares over finance — exposes only
  `findById` and `findPaidForArtist`, and the latter filters
  `status: 'PAID'` on `paidAt`. **There is no method on it that returns an
  accrual.** A 1099-NEC Box 1 built from the royalty ledger is not something a
  developer has to remember not to write; there is no API for it.
- `TaxReturnFiling.payoutId` is a real FK, and `TaxFilingService.create` refuses
  a `FORM_16A` / `FORM_1099_NEC` whose payout is not `PAID`:

  > Form 16A and 1099-NEC report royalty that was *paid*; this payout is
  > APPROVED. It becomes reportable once the transfer executes, and carries
  > forward to the next cycle until then.

- A payout still pending or rejected at a filing deadline is simply absent from
  `findPaidForArtist`, so it is excluded from the filing and carries forward.

### The separation-of-duties control 8 asks for

The guide recommends adding this "as an explicit control point when Phase 3 (Tax
Filing) is implemented". It is implemented now, in two places:

- The operator who **approved a payout** may not create the Form 16A / 1099-NEC
  reporting it (`TAX_SEPARATION_OF_DUTIES`).
- The operator who **raised a tax adjustment** may not approve it — approval
  takes `payment-royalty:override`, a different capability from the `manage` that
  raises one.

### The three new RBAC permissions (8, "New RBAC dependency")

`drop.create_with_cogs_sales_price`, `artist.set_royalty_rate` and
`payout.approve_and_execute` are ⬜ **not this module's** — they belong to the
drops, artist and finance surfaces. This module's dependency on them is
indirect: it trusts that a payout reaching `PAID` went through whatever approval
`payout.approve_and_execute` gates, and it enforces the separation-of-duties
half of that contract on its own side.

---

## Summary of deliberate deviations

| Deviation | Reason |
| --- | --- |
| Rates are `Decimal(6,3)`, not `(5,2)` | The guide's own 8.625% example does not fit in `(5,2)` |
| `InvoiceLineItem` added | GSTR-1 is filed on an HSN-wise summary of lines |
| `InvoiceNumberSequence` added | A Postgres sequence cannot be gap-free |
| `artist_tax_compliance` not extended; `ArtistTaxDocument` carries the fields | That table does not exist, and document history is worth keeping |
| `payoutId` FKs `RoyaltyPayout`, not a new `payout_approval_queue` | The approved-payout record already exists in finance; a second one would be a second truth |
| No `DRAFT` invoice status | Issuing a number that may never be used puts a gap in the series |
| No bank account number on the invoice | HitBox is paid before the invoice exists; the document is a receipt, not a request for payment |
| Amounts print `INR 2,000.00`, not `₹2,000.00` | PDFKit's built-in fonts are WinAnsi and have no ₹; embedding a font to gain one glyph adds a dependency the render can lose |
| Invoice number is 21 chars, over India's 16-char cap | The cap applies to the number as filed; `toGstFilingFormat()` produces the 15-char form for the day GSTR-1 filing goes live |
