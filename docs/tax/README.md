# Tax & invoicing

`@hitbox/tax` — GST and US sales tax, the customer invoice, the PDF on S3, artist
tax paperwork, and the returns all of it is reported on.

It implements the **HitBox Tax & Invoicing Compliance Guide v1.1** (2026-09-15).
Every design decision below traces back to a section of that guide;
[compliance-mapping.md](compliance-mapping.md) is the section-by-section index,
and is the document to read if you want to check that something in the guide
actually got built.

| Document | What it covers |
| --- | --- |
| [invoice-generation.md](invoice-generation.md) | When an invoice is issued, how it is numbered, how the PDF is produced, and what is on it |
| [api-reference.md](api-reference.md) | **Every endpoint, its access level, and the artist / admin split** |
| [s3-storage.md](s3-storage.md) | Bucket layout, IAM, lifecycle, encryption, and the verification run |
| [schema.md](schema.md) | The seven tables this module owns and why each column exists |
| [compliance-mapping.md](compliance-mapping.md) | Guide § → what was built, and what was deliberately not |
| [demo-invoice.md](demo-invoice.md) | The two reference invoices, annotated |
| [examples/](examples/) | The rendered reference PDFs themselves |

---

## 1. What this module is, and what it is not

**It is the statutory record.** What HitBox charged a customer in tax, on what
document, at what rate, under which classification code, and what it filed that
on. If a tax authority asks a question, the answer is in these seven tables.

**It is not accounting.** What HitBox *earned* — royalty accrual, payout
batches, the platform revenue ledger — is `@hitbox/finance`, and the boundary
between the two is sharp:

| | `@hitbox/finance` | `@hitbox/tax` |
| --- | --- | --- |
| Question it answers | What did we earn, and who do we owe? | What do we owe a government, and what did we tell them? |
| Trigger | `claims.product.claimed` | `payments.order.settled` |
| Artefact | Ledger entries, payout batches | Invoices, returns, certificates |
| Mutability | Append-only | Append-only |

The two touch in exactly one place, and it is a one-way port: a Form 16A or a
1099-NEC has to point at a payout that finance actually executed. Tax asks
finance through `IPayoutLookup`; finance knows nothing about tax.

---

## 2. The five decisions worth knowing up front

**Invoices are issued at settlement, not at claim.** Finance accrues royalty
when the NFC tag is tapped, because HitBox has not earned anything until the
buyer holds the item. Tax cannot wait for that: tax is due on the *supply*, and
an order paid in March and claimed in April belongs on March's GSTR-1. This is
the one place the two modules deliberately diverge — see
[invoice-generation.md §2](invoice-generation.md#2-when-an-invoice-is-issued).

**Invoice numbers are gap-free, and that costs a lock.** GST law requires a
unique, sequential, gap-free series per fiscal year. A Postgres `SEQUENCE`
cannot provide it — `nextval` is non-transactional, so a rolled-back invoice
burns a number and leaves a hole an auditor will ask about. The counter is a
row (`InvoiceNumberSequence`) locked and incremented inside the same transaction
as the insert. Invoice creation therefore serialises per (country, fiscal year),
which at HitBox's volume is nothing, and is the correct trade.

**Everything on an invoice is a snapshot.** The rate, the HSN code, the unit
price, and HitBox's own GSTIN are all copied onto the row at issue. A later edit
to the rate table, the product, or the company's registration must never change
what an already-issued invoice says — that document has left the building and
been filed on a return.

**Nothing is edited or deleted.** A cancelled invoice becomes `VOID` and keeps
its number (which is reported as void and never reused). A wrong tax figure is
corrected by a `TaxAdjustmentEntry` pointing at the original, approved by
someone other than the person who raised it. Same rule the finance ledgers
follow.

**This module adds no new permissions.** Invoices are payment records, a W-9 is
a document, a GSTR-1 export is a report — the access-control catalog already has
all three. Inventing `tax:*` would mean a new `ResourceType` enum value, a
migration, and a second place where "who may see money" is decided. See
[api-reference.md §2](api-reference.md#2-the-capabilities-and-why-these-ones).

---

## 3. Shape of the package

```text
packages/tax/
  prisma/tax.prisma              7 models + 8 enums (see schema.md)
  assets/
    hitbox-logo.svg              the brand mark — source of truth
    hitbox-logo.png              GENERATED raster (384px, for PDFKit)
  scripts/
    generate-logo.ts             rasterises the SVG + emits the base64 module
    render-demo-invoice.ts       renders the two reference invoices; --upload
                                 also proves the bucket wiring end to end
  src/
    domain/                      pure, no database, no clock, no request
      money.ts                   decimal arithmetic on strings (no floats)
      tax-calculation.ts         per-line tax, and rate resolution
      fiscal-calendar.ts         India Apr–Mar vs US calendar year, due dates
      invoice-number.ts          INV-2026-27-IN-001234
      amount-in-words.ts         "Rupees Two Thousand Two Hundred Forty Only"
      document-storage-key.ts    the three S3 prefixes, and path safety
      supplier-profile.ts        HitBox's own GSTIN / EIN per jurisdiction
      tax-access.ts              grant -> what this response may contain
      interfaces/                the four ports bootstrap fills in
    infrastructure/
      invoice-pdf.renderer.ts    PDFKit; a pure projection of the invoice row
      hitbox-logo.asset.ts       GENERATED — the mark, embedded as base64
      s3-document-storage.ts     the only file here that knows about AWS
    repository/                  the only files that touch Prisma
    service/                     the rules
    controller/ dto/ module.ts
```

The four ports, and who fills them in `apps/backend/src/bootstrap.ts`:

| Port | Provider | Question |
| --- | --- | --- |
| `IInvoiceableOrderSource` | `ordersModule.invoicing` | Who bought what, at what price, billed where? |
| `IPayoutLookup` | `financeModule.payoutReporting` | Was this payout actually *paid*, and who approved it? |
| `IArtistOwnership` | `artistModule.ownership` | Which artist records does this user act for? |
| `IDocumentStorage` | `S3DocumentStorage` | Put these bytes; give me a short-lived read link. |

Consumer declares the port, provider writes the adapter, bootstrap connects
them — the pattern from [hitbox-architecture.md §6](../hitbox-architecture.md).
Tax reads no other module's tables.

---

## 4. Configuration

Everything is optional; the module degrades rather than failing to boot.

| Variable | Effect if absent |
| --- | --- |
| `TAX_SUPPLIER_IN_GSTIN` | **No Indian invoice can be issued** — an invoice without the supplier's GSTIN is not a tax invoice. Fails at issue with `TAX_SUPPLIER_NOT_CONFIGURED`. |
| `TAX_SUPPLIER_IN_PAN` / `_NAME` / `_ADDRESS` / `_PHONE` | Printed blank or defaulted; only the GSTIN blocks issue. |
| `TAX_SUPPLIER_US_EIN` / `_NAME` / `_ADDRESS` / `_PHONE` | US invoices still issue — there is no federal invoice law. |
| `TAX_SUPPLIER_EMAIL` | Omitted from the "FROM" block. |
| `TAX_INVOICE_LOGO_PATH` | The embedded HitBox mark is used. A path that does not exist also falls back to it. |
| `TAX_S3_KMS_KEY_ID` | The bucket's default encryption applies. |
| `MEDIA_S3_BUCKET` / `_REGION` | Invoices are still **issued** and every figure recorded; only the document routes report storage unavailable. |

Addresses are pipe-separated, one line per segment:

```bash
TAX_SUPPLIER_IN_ADDRESS="4th Floor, Prestige Atrium|Bengaluru, Karnataka 560001|India"
```

No bank account numbers, deliberately. The compliance guide's example invoice
prints `Account: [HitBox Account]` — a placeholder there, and a placeholder
here. HitBox is paid through the gateway before the invoice exists, so the
document is a receipt rather than a request for payment, and printing an account
number on every customer-facing PDF would be a fraud surface for no benefit.

---

## 5. Current status

| | |
| --- | --- |
| Schema | ✅ merged and validated (`pnpm db:validate`) — **migration not yet run** |
| Invoice generation, numbering, PDF | ✅ built, 72 unit tests |
| S3 storage | ✅ built and **verified against the live `hitbox-media-dev` bucket** — see [s3-storage.md §6](s3-storage.md#6-verification-run) |
| Rates, artist documents, filings, adjustments | ✅ built |
| Buyer + admin APIs | ✅ built and mounted |
| GSTR-1 / sales-tax / 1099 / 16A **data** | ✅ built (the figures a return is filed from) |
| Direct filing to the GST portal / IRS FIRE | ❌ not built — returns are filed by hand and their acknowledgement recorded |
| Form 16A / 1099-NEC **PDF** generation | ❌ not built — the figures and the payout link exist; the certificate document does not |
| Invoice e-mail delivery | ❌ not built — `Invoice.deliveredAt` exists for it |
| `product_cost` linkage | ⏳ column exists, nullable, no FK — see [compliance-mapping.md §8](compliance-mapping.md#8-the-2026-09-15-business-logic-changes) |

Before first production use, run the migration and complete the checklist in
[s3-storage.md §7](s3-storage.md#7-before-first-production-use).
