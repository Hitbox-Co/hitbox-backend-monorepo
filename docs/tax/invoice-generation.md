# Invoice generation

How a settled order becomes a numbered, rendered, stored tax invoice.

---

## 1. The pipeline

```text
  payments.order.settled                POST /admin/tax/invoices
            │                                      │
            └──────────────┬───────────────────────┘
                           ▼
              InvoiceService.issueForOrder
                           │
   ┌───────────────────────┼───────────────────────────────┐
   ▼                       ▼                               ▼
already invoiced?    order settled?              supplier profile for
return it            else refuse                 this jurisdiction?
(idempotent)                                     else refuse
                           │
                           ▼
              resolve the tax rate  ── none? refuse, do not guess
                           │
                           ▼
              calculateInvoice()   per line, half-up, no floats
                           │
                           ▼
   ┌───────── ONE TRANSACTION ──────────────────────────────┐
   │  lock + increment InvoiceNumberSequence                │
   │  INSERT Invoice  (number, snapshots, ISSUED)           │
   │  INSERT InvoiceLineItem[]                              │
   └────────────────────────────────────────────────────────┘
                           │
                           ▼           ← the invoice legally EXISTS here
              audit + publish tax.invoice.issued
                           │
                           ▼
              render PDF → PUT to S3 → attach key + sha256
              (best-effort; failure is logged, not fatal)
```

The line worth staring at is the one after the transaction. **The invoice exists
the moment its number is minted.** The PDF is a projection of the row and can be
produced again at any time, so a bucket outage must not be able to stop HitBox
issuing a document it is legally required to issue. A failed render logs

> invoice PDF could not be rendered or stored — the invoice is issued;
> regenerate the document with `POST /admin/tax/invoices/:id/regenerate`

and the row carries `pdfStorageRef: null` until someone does.

---

## 2. When an invoice is issued

**On `payments.order.settled`.** Not on order placement, and not on claim.

This is the one place `@hitbox/tax` deliberately differs from `@hitbox/finance`,
and the reason is worth keeping straight:

| | Trigger | Why |
| --- | --- | --- |
| Royalty accrual (finance) | `claims.product.claimed` | HitBox has not *earned* anything until the physical item is in the buyer's hands and its tag is tapped |
| Invoice (tax) | `payments.order.settled` | Tax is due on the **supply**, which happens when the customer pays and the goods go out |

Waiting for the claim would put an order paid in March and claimed in April on
the wrong GSTR-1 period. Issuing at order placement would be worse: it would put
a number into the statutory series for a supply that may never happen, and a
number issued and then abandoned is a gap.

The subscriber swallows its own errors — the event bus isolates a throwing
subscriber anyway, and an invoice that could not be issued is an operational
problem to alert on, not a lost payment. Same shape as finance's accrual
handler.

Settled means `PAID`, `PROCESSING`, `SHIPPED` or `DELIVERED`.

---

## 3. Numbering

```
INV-2026-27-IN-001234
└┬┘ └──┬──┘ └┬┘ └──┬─┘
 │     │     │     └── sequence within the series, zero-padded to 6
 │     │     └──────── jurisdiction — each country numbers independently
 │     └────────────── fiscal year the series belongs to
 └──────────────────── fixed prefix
```

Fiscal years differ: India runs **1 April – 31 March** and is written `2026-27`;
the US uses the calendar year, `2026`. Boundaries are computed in UTC, because
which financial year an invoice falls in is a legal fact about a date, not about
the server's timezone.

### Why the counter is a table row and not a sequence

GST law requires the series to be unique, sequential and **gap-free** within a
financial year. A Postgres `SEQUENCE` cannot deliver that: `nextval` is
deliberately non-transactional, so an invoice that rolls back burns its number
and leaves a hole — and a hole in the series is something an auditor will ask
about.

`InvoiceNumberSequence` is instead read and incremented inside the same
transaction as the insert:

```ts
const sequence = await tx.invoiceNumberSequence.upsert({
    where: { countryCode_fiscalYear: { countryCode, fiscalYear } },
    create: { …, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
});
const { invoice, lines } = build(sequence.lastNumber);
await tx.invoice.create({ data: { ...invoice, id } });
await tx.invoiceLineItem.createMany({ … });
```

If the invoice rolls back, so does the counter. The cost is that invoice
creation serialises per (country, fiscal year); at HitBox's volume that is
nothing, and a few milliseconds of lock contention is a much better problem than
a compliance finding. `upsert` also makes the first invoice of a new fiscal year
self-initialising, so nothing has to remember to seed April.

### The 16-character caveat

Indian GST caps an invoice number at 16 characters. The readable form above is
21 — a deliberate, recorded trade rather than an oversight. The limit applies to
the number *as filed on a return*, and HitBox is not filing GSTR-1 yet. When
that lands (roadmap Phase 3), `toGstFilingFormat()` already produces the
compliant short form:

```
INV-2026-27-IN-001234  →  INV-2627-000123   (15 characters)
```

The part that has to be gap-free — the sequence itself — is unaffected by the
change.

---

## 4. The arithmetic

In `domain/money.ts` and `domain/tax-calculation.ts`. Nothing goes through
`number`: amounts are scaled `bigint`s internally and the only conversion to a
fixed scale is one explicit rounding step at the end.

**Half-up, not banker's rounding.** Both regimes round half away from zero at
the invoice level.

**Tax is computed per line and then summed, not on the subtotal.** With one line
and one rate the two are identical — which is every invoice HitBox issues
today — but they diverge the moment an invoice carries a 12% collectible and an
18% premium item, and a return is filed on the line-level figures. Getting the
order of operations right now costs nothing; changing it later would mean
re-deriving already-filed numbers.

**Rates carry three decimals.** `Decimal(6,3)`, not `(5,2)`. US combined
state+county+district rates routinely carry a third decimal — California's
8.625%, New York City's 8.875% — and rounding one to 8.63% prints a rate that
appears in no state rate table and cannot be reconciled against one.

The two worked examples from the compliance guide, both pinned by tests:

| | India (1.1, 1.4) | United States (2.1, 2.3) |
| --- | --- | --- |
| Sale price | ₹2,000.00 | $25.00 |
| Rate | GST 12% | Sales tax 8.625% |
| Tax | ₹240.00 | $2.16 (exact product 2.15625) |
| Total | ₹2,240.00 | $27.16 |

---

## 5. Rate resolution

Most-specific-first, evaluated at the **invoice date** so re-deriving an old
invoice reproduces the rate that was actually charged:

```
product + state  →  product + country  →  state default  →  country default
```

A product with no row of its own falls back to the jurisdiction's default —
"no configuration for a product" is normal. No configuration for the *country*
is a setup error and fails loudly:

> No tax rate is configured for KA-IN on 2026-09-15. Configure one before
> invoicing sales in this jurisdiction — issuing an invoice at an assumed rate
> is worse than not issuing one.

**Jurisdiction comes from the billing address**, not from the currency and not
from the buyer's profile country: US sales tax is a destination tax keyed to
where the customer is, and Indian GST turns on the place of supply. Currency is
only the fallback for a digital order with no address captured, and it is a weak
one — a card can be billed in USD from anywhere.

---

## 6. What is snapshotted onto the invoice

Everything that could later change:

| Snapshot | Why |
| --- | --- |
| `taxRate`, `hsnCode` | The rate table is versioned; an issued invoice must keep saying what it said |
| `unitPrice`, `salesPriceSnapshot` | Guide 8.1 — a later re-versioning of the drop's pricing must never retroactively change an issued invoice |
| `supplierName/Address/Gstin/Pan/Ein` | Registrations get amended and offices move |
| `customerName/Email/Address` | The address book entry may be edited or deleted |
| Line `description` | A renamed product must not rename an issued invoice's line |

`productCostId` is a plain UUID with **no foreign key**: the versioned
`product_cost` table from the 2026-09-15 business-logic change does not exist in
this schema yet, and an invoice must never be blocked from being issued by a
pricing table it does not own. The column is there, nullable, ready.

---

## 7. The document

`infrastructure/invoice-pdf.renderer.ts`. A **pure projection** of the invoice
row: every figure is passed in already computed, nothing reads the database, the
clock or configuration, and re-rendering the same row produces a byte-identical
PDF (pinned by a test — an invoice can be re-produced years later and still hash
the same).

**A4, not Letter.** India is the jurisdiction with a statutory invoice format,
and A4 is what gets printed and filed there. A US invoice on A4 is
unremarkable; an Indian invoice on Letter looks wrong to whoever files it.

**Built-in fonts only.** Helvetica/Helvetica-Bold ship inside PDFKit, so the
document renders identically on any machine with no font to install and none to
lose. The cost is WinAnsi's character set, which has no ₹ (U+20B9) — so amounts
print as `INR 2,000.00` rather than `₹2,000.00`. Embedding a Unicode font to
gain one glyph would mean shipping a font file the render depends on; the ISO
code is what a bank statement and a GST return both use and cannot render
incorrectly.

**Digit grouping follows the jurisdiction.** INR uses the lakh/crore
system — `12,34,567.00` — and everything else groups in threes. An Indian
invoice that groups in thousands looks foreign to the person reading it.

**The logo is embedded, not read from disk.** `hitbox-logo.asset.ts` carries the
brand mark as base64, rasterised from `assets/hitbox-logo.svg` by
`scripts/generate-logo.ts` (`pnpm --filter @hitbox/tax logo:generate`). Two
reasons it is a generated PNG rather than the SVG itself: PDFKit's `doc.image()`
accepts PNG and JPEG only, and an invoice is a statutory document that must
render identically in the server (ESM), in a test (CommonJS) and in a bundle
with no assets directory beside it. `TAX_INVOICE_LOGO_PATH` overrides it with a
PNG on disk; a path that does not exist falls back to the embedded mark rather
than failing, because a wrong logo is cosmetic and an invoice that could not be
issued is not.

The mark is square, so the "HITBOX / COLLECTIBLES" wordmark beside it is drawn
as type rather than being part of the image.

### The mandatory-field gate

1.4 of the compliance guide lists eight mandatory fields for an Indian GST
invoice. `assertRenderable` checks them **before a single byte is drawn**,
because a PDF missing a GSTIN is not a deficient invoice — it is not an invoice,
and discovering that at filing time is much worse than at issue:

```
Cannot render invoice INV-2026-27-IN-001234: missing supplier's GSTIN;
HSN/SAC code on line 1. These fields are mandatory for a IN tax invoice.
```

Every missing field is named at once, rather than one per attempt. The US has no
federal invoice law, so its invoices are checked only for the things that make a
document usable — a number, a date, at least one line.

### What is on the page

Header (logo, `TAX INVOICE` / `INVOICE`, statutory subtitle) · FROM block with
GSTIN/PAN/EIN · BILL TO block with the customer's GSTIN or an explicit
"Not applicable (B2C)" · meta strip (number, dates, order ref, place of supply,
currency) · line-item table with HSN/SAC, quantity, unit price, taxable value,
rate and tax · amount in words · totals with the tax named for its regime ·
payment and terms · authorised-signatory box · per-page footer. A non-`ISSUED`
invoice gets a diagonal `VOID` or `CORRECTED` stamp over the content.

The HSN/SAC column exists **only** on Indian invoices — it is mandatory there
and meaningless in the US, and an empty column reads as missing data.

Amount in words is conventional on an Indian invoice and a genuine control: a
transposed digit in `24,20.00` is invisible, and "Rupees Two Thousand Two
Hundred Forty Only" is not.

See [demo-invoice.md](demo-invoice.md) for the annotated output.

---

## 8. Cancelling and correcting

There is no delete anywhere in this module.

**Void** — `POST /admin/tax/invoices/:id/void`. Status becomes `VOID`, the
number is retained and reported as void, and the stored PDF is **re-rendered
with the stamp**: the customer already has a link to that object and it must
stop reading like a valid invoice.

**Correct** — a `TaxAdjustmentEntry` pointing at the original, raised by one
operator (`manage`) and approved by another (`override`). The invoice row is not
rewritten. A tax authority reading the trail sees both what was filed and what
changed.

---

## 9. Running it yourself

```bash
pnpm --filter @hitbox/tax test
```

```bash
pnpm --filter @hitbox/tax demo:invoice
```

Renders the two reference invoices to `docs/tax/examples/`. Add `--upload` (with
`MEDIA_S3_BUCKET` and AWS credentials in the environment) to also put them in
S3 — which doubles as the bucket smoke test, see
[s3-storage.md 6](s3-storage.md#6-verification-run).
