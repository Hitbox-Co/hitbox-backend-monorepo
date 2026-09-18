# Tax & invoicing — API reference and access levels

Every endpoint `@hitbox/tax` mounts, what it takes, and **who can call it**.

Three audiences share these routes, and the whole point of this document is the
line between them:

| Audience | Holds | Reaches |
| --- | --- | --- |
| **Buyer** | `order:read:own` | Their own invoices. Nothing else in this module. |
| **Artist** | `payment-royalty:read:own` | Their own tax documents and their own 1099-NEC / Form 16A figures. |
| **HitBox admin** | `payment-royalty:manage:global` (+ `:override`, `reports-dashboards:export:global`) | Everything. |

Base path: `/api/v1`. Every route below requires authentication first
(`requireAuth`); the capability is checked after.

---

## 1. Quick index

### Buyer surface — `/api/v1/invoices`

| Method | Path | Capability |
| --- | --- | --- |
| GET | `/invoices` | `order:read` |
| GET | `/invoices/:invoiceId` | `order:read` |
| GET | `/invoices/:invoiceId/download` | `order:read` |

### Artist surface — `/api/v1/admin/tax/…`

Same paths an admin uses; the caller's grant narrows the rows.

| Method | Path | Capability | What an artist gets |
| --- | --- | --- | --- |
| GET | `/admin/tax/artist-documents` | `payment-royalty:read` | Only their own documents |
| POST | `/admin/tax/artist-documents` | `payment-royalty:read` | Register their own W-9 / PAN / GSTIN |
| GET | `/admin/tax/artist-documents/:documentId` | `payment-royalty:read` | Only their own |
| GET | `/admin/tax/artist-documents/:documentId/download` | `payment-royalty:read` | Only their own |
| GET | `/admin/tax/filings` | `payment-royalty:read` | Only Form 16A / 1099-NEC rows naming them |
| GET | `/admin/tax/filings/:filingId` | `payment-royalty:read` | Only their own; platform returns are refused |
| GET | `/admin/tax/reports/form-1099-nec` | `payment-royalty:read` | Only `?artistId=` themselves |
| GET | `/admin/tax/reports/form-16a` | `payment-royalty:read` | Only `?artistId=` themselves |

### HitBox admin surface — `/api/v1/admin/tax/…`

| Method | Path | Capability | Scope |
| --- | --- | --- | --- |
| GET | `/admin/tax/configurations` | `payment-royalty:read` | |
| POST | `/admin/tax/configurations` | `payment-royalty:manage` | **global only** |
| GET | `/admin/tax/configurations/:configurationId` | `payment-royalty:read` | |
| POST | `/admin/tax/configurations/:configurationId/close` | `payment-royalty:manage` | **global only** |
| GET | `/admin/tax/invoices` | `payment-royalty:read` | own / org / global |
| POST | `/admin/tax/invoices` | `payment-royalty:manage` | **global only** |
| GET | `/admin/tax/invoices/:invoiceId` | `payment-royalty:read` | own / org / global |
| GET | `/admin/tax/invoices/:invoiceId/download` | `payment-royalty:read` | own / org / global |
| POST | `/admin/tax/invoices/:invoiceId/void` | `payment-royalty:manage` | **global only** |
| POST | `/admin/tax/invoices/:invoiceId/regenerate` | `payment-royalty:manage` | **global only** |
| POST | `/admin/tax/artist-documents/:documentId/review` | `payment-royalty:manage` | **global only** |
| POST | `/admin/tax/filings` | `payment-royalty:manage` | **global only** |
| POST | `/admin/tax/filings/:filingId/file` | `payment-royalty:manage` | **global only** |
| GET | `/admin/tax/reports/indirect-tax` | `payment-royalty:read` | **global only** (service-enforced) |
| GET | `/admin/tax/reports/export` | `reports-dashboards:export` | **global only** |
| GET | `/admin/tax/adjustments` | `payment-royalty:read` + manage | **global only** (service-enforced) |
| POST | `/admin/tax/adjustments` | `payment-royalty:manage` | **global only** |
| POST | `/admin/tax/adjustments/:adjustmentId/decide` | `payment-royalty:override` | **global only** |

---

## 2. The capabilities, and why these ones

This module defines **no new permissions**. Five existing catalog capabilities
carry the whole surface:

| Capability | Used for |
| --- | --- |
| `order:read` | A buyer reaching the invoice for their own order |
| `payment-royalty:read` | Reading invoices, rates, filings, artist documents |
| `payment-royalty:manage` | Writing rates, issuing/voiding invoices, verifying documents, creating filings |
| `payment-royalty:override` | Approving a correction to an already-reported figure |
| `reports-dashboards:export` | Copying return rows out of the platform in bulk |

Inventing a `tax:*` resource would mean a new `ResourceType` enum value, a
migration, and a second place where "who may see money" is decided. An invoice
*is* a payment record; a W-9 *is* a document; a GSTR-1 export *is* a report.
`@hitbox/finance` adds none either, for the same reason.

Three of these are deliberately separate powers rather than degrees of one:

- **`manage` is not `read`.** Reading what HitBox charged in tax and changing
  what it charges are different jobs.
- **`override` is not `manage`.** Raising a correction is the normal act of an
  operator who spotted a wrong rate. *Approving* one changes a figure already
  reported to a tax authority. The catalog already separates them, so this
  module does too.
- **`export` is not `read`.** Reading a return's totals is an aggregate.
  Exporting the rows behind it copies customer names and addresses out of the
  platform.

### What `globalOnly` means here

A route marked **global only** passes `{ globalOnly: true }` to the guard, so a
holder of `payment-royalty:manage:organization` — a brand admin, say — is
refused. Writing a tax rate, issuing an invoice and marking a return filed are
platform-level acts *against a government*; a brand that manages its own drops
does not get to file HitBox's GSTR-1. The services re-check with
`requireTaxManage` / `requireTaxOverride` / `requireTaxExport` so the rule holds
even for a caller that reached a service by another path.

---

## 3. How scope narrows a response

Resolved from the grant, in `domain/tax-access.ts`. **Never from the request** —
there is no `?artistId=` or `?buyerId=` a client can send to widen its own view.

| Scope | Granted by | Reaches |
| --- | --- | --- |
| `BUYER` | `order:read:own` (buyer routes only) | Invoices where `buyerId` is the caller |
| `OWN` | `payment-royalty:read:own` | Tax documents and information returns for the artist records this user acts for |
| `ORGANIZATION` | `payment-royalty:read:organization` | Invoices whose `organizationId` is one of the caller's |
| `GLOBAL` | `payment-royalty:read:global` | Everything |

Two properties of this that are easy to get wrong and are pinned by tests:

**The buyer surface is always `BUYER`.** `buildBuyerTaxAccess` returns `BUYER`
scope even for a caller who also holds `payment-royalty:read:global`. A finance
operator hitting `GET /invoices` sees their own purchases and uses
`GET /admin/tax/invoices` for everyone else's. The buyer surface's contract is
"your own receipts", and a wider grant must not change what it returns.

**A caller with no `payment-royalty` grant is refused, not given an empty
list.** An empty page and a 403 mean very different things to whoever is reading
the screen, and "you have no invoices" is a claim worth making only when true.

### Field-level narrowing

Scope decides which rows; it also decides which fields.

| Field | Buyer | Artist (`OWN`) | Admin (`GLOBAL`) |
| --- | --- | --- | --- |
| Invoice figures, line items, supplier, customer | ✅ | ✅ | ✅ |
| `pdfStorageRef`, `pdfSha256` | ❌ | ❌ | ✅ |
| `buyerId`, `organizationId`, `createdById` | ❌ | ❌ | ✅ |
| `salesPriceSnapshot`, `productCostId` | ❌ | ❌ | ✅ |
| Artist document `documentNumber` (PAN/GSTIN) | n/a | ✅ own only | ✅ |
| Artist document `documentStorageRef` | n/a | ❌ | ❌ |

The storage key is withheld from everyone: the file is reached through the
presigned-download route after a permission check, and a key is the one string
that makes a bucket worth probing. `documentNumber` never holds an SSN or EIN —
that number stays inside the W-9 PDF, which is access-controlled as a whole.

---

## 4. Separation of duties

Three rules where holding the right capability is still not enough. All three
come from the control point 8 of the compliance guide asks for.

| Rule | Where | Why |
| --- | --- | --- |
| The operator who **approved a payout** may not create the Form 16A / 1099-NEC that reports it | `TaxFilingService.create` → `TAX_SEPARATION_OF_DUTIES` | One person should not both release money and produce the document saying it was released |
| The operator who **raised a tax adjustment** may not approve it | `TaxAdjustmentService.decide` → `TAX_SEPARATION_OF_DUTIES` | A single person able to both assert and accept a change to a filed tax figure is the exact shape of control failure an audit looks for |
| An **artist may not verify their own W-9** | `review` is `manage`-gated; registration is `read`-gated | The review step is the entire point of having one |

---

## 5. Endpoint detail

### 5.1 Buyer — their own invoices

#### `GET /api/v1/invoices`

**`order:read:own`.** Always `BUYER` scope.

Query: `page`, `limit` (max 100), `countryCode`, `status`, `fiscalYear`,
`issuedFrom`, `issuedTo` (half-open: `issuedFrom <= invoiceDate < issuedTo`).
`buyerId` in the query is ignored — the caller's own id always wins.

```json
{
  "data": [{
    "id": "…", "invoiceNumber": "INV-2026-27-IN-001234",
    "invoiceDate": "2026-09-15T10:30:00.000Z", "fiscalYear": "2026-27",
    "status": "ISSUED", "orderId": "…",
    "countryCode": "IN", "stateCode": "KA", "currency": "INR",
    "taxType": "GST", "taxRate": "12.000", "hsnCode": "9706",
    "subtotal": "2000.00", "taxAmount": "240.00", "totalAmount": "2240.00",
    "supplier": { "name": "…", "address": "…", "gstin": "29AABCH5055K1Z4", "pan": "…", "ein": null },
    "customer": { "name": "Arjun Singh", "email": "…", "address": "…", "gstin": null },
    "lineItems": [{ "position": 1, "description": "…", "hsnCode": "9706",
                    "quantity": 1, "unitPrice": "2000.00", "lineSubtotal": "2000.00",
                    "taxRate": "12.000", "taxAmount": "240.00", "lineTotal": "2240.00" }],
    "documentAvailable": true, "notes": null, "issuedAt": "…"
  }],
  "meta": { "page": 1, "limit": 20, "total": 3 }
}
```

Every money value and every rate is a **string**. A tax figure that arrives as a
JSON float and is summed client-side produces a number that will not reconcile
against a return.

#### `GET /api/v1/invoices/:invoiceId`

Another buyer's invoice returns **404, not 403** — a buyer may not learn that it
exists.

#### `GET /api/v1/invoices/:invoiceId/download`

Returns a presigned GET URL valid for **300 seconds**. The bytes go straight
from S3 to the client and never through this process. If the PDF has not been
rendered yet, it is rendered on the spot rather than telling the customer their
receipt is unavailable.

```json
{ "data": { "url": "https://…", "expiresIn": 300, "invoiceNumber": "INV-2026-27-IN-001234" } }
```

Audited as `tax.invoice.download` — fetching an invoice discloses a name and a
postal address, and "who looked at this" is a question both a tax audit and a
data-subject request will ask.

---

### 5.2 Tax configuration — rates and HSN/SAC codes

Rates are **versioned, never edited**: there is no `PUT`, `PATCH` or `DELETE`.
A new rate is a new row with an effective window, which is what makes
re-deriving a two-year-old invoice produce the figure that was actually on it.

#### `POST /admin/tax/configurations` — `payment-royalty:manage:global`

```json
{
  "productId": "…",            // omit for the jurisdiction default
  "countryCode": "IN",
  "stateCode": "CA",           // US only
  "taxType": "GST",            // GST | SALES_TAX | EXEMPT
  "taxRate": "12",             // up to 3 decimals: "8.625" is valid
  "hsnCode": "9706",           // mandatory for IN (validated)
  "sacCode": "998361",
  "exemptionReason": "…",      // mandatory when taxType is EXEMPT
  "effectiveFrom": "2026-04-01T00:00:00Z",
  "effectiveTo": null
}
```

- `countryCode: "IN"` with no `hsnCode` **or** `sacCode` is rejected — a GST
  invoice must carry one, and the department matches it against GSTR-1.
- An overlapping window for the same target is rejected with `409`. Two rows at
  the same specificity would make rate resolution depend on a tie-break, and
  "probably right" is not good enough for a figure that goes on a filing.

#### `POST /admin/tax/configurations/:configurationId/close`

`{ "effectiveTo": "2026-09-30T00:00:00Z", "reason": "GST rate notification 12/2026" }`

The only mutation this table allows.

**Rate resolution**, most-specific-first, evaluated at the invoice date:

```
product + state  →  product + country  →  state default  →  country default
```

A product with no row of its own falls back to the jurisdiction default. No row
for the *country* is a setup error and fails loudly with
`TAX_NO_CONFIGURATION` — issuing an invoice at an assumed rate is worse than not
issuing one.

---

### 5.3 Invoices — operator

#### `POST /admin/tax/invoices` — `payment-royalty:manage:global`

`{ "orderId": "…", "invoiceDate": "…", "notes": "…" }`

Only an order id. The price, the buyer, the address and the rate are all
resolved server-side: a client that could supply an amount could supply the
wrong one, and the resulting document would still be a statutory record.

**Idempotent** — `Invoice.orderId` is unique, and an order that already has an
invoice returns the existing one. The settlement subscriber calls the same
method, so a redelivered event cannot mint a second number for one supply.

| Failure | Code |
| --- | --- |
| Order is `PENDING_PAYMENT` or `CANCELLED` | `TAX_ORDER_NOT_INVOICEABLE` |
| No rate configured for the jurisdiction | `TAX_NO_CONFIGURATION` |
| No supplier profile (or no GSTIN for `IN`) | `TAX_SUPPLIER_NOT_CONFIGURED` |

#### `POST /admin/tax/invoices/:invoiceId/void`

`{ "reason": "Duplicate of INV-2026-27-IN-001233" }`

Status moves to `VOID`; the number is retained and reported as void, never
reused. The stored PDF is re-rendered with a diagonal `VOID` stamp — the
customer already has a link to that object, and it must stop reading like a
valid invoice.

#### `POST /admin/tax/invoices/:invoiceId/regenerate`

Re-renders and re-stores the PDF from the row. Idempotent, and byte-identical
for an unchanged row. This is the recovery path when an invoice was issued while
S3 was unreachable — the row is the statutory record, the PDF is a projection.

---

### 5.4 Artist tax documents — W-9, PAN, GSTIN

The rule this surface exists to enforce (guide 2.2): **HitBox must have a valid
W-9 on file before the first payment to a US artist, and without one the IRS
requires 24% backup withholding.** A document's verification state decides how
much money the artist receives.

#### `POST /admin/tax/artist-documents` — `payment-royalty:read`

`read`-gated, not `manage`: an artist registering their **own** W-9 is the
normal path and they hold `read:own`. The service refuses a different artist's
id.

```json
{
  "artistId": "…", "countryCode": "US", "documentType": "W9",
  "storageRef": "tax-artist-documents/artists/…/W9/….pdf",
  "documentSha256": "…", "documentNumber": null,
  "issuerName": "LeBron Collectibles LLC",
  "issueDate": "2026-09-01", "expiresAt": null
}
```

The file itself goes to S3 through the media module's presigned upload; this
records the result. Keeping the bytes off this endpoint means a 30 MB scan never
travels through the JSON body of an API that also writes a database row.

`documentNumber` is format-validated: PAN is `AAAAA9999A`, GSTIN is the 15-char
form. It holds business identifiers only — an SSN stays inside the PDF.

A new document **archives** whatever it replaces, in one transaction. HitBox has
to be able to show which W-9 was on file when a payment was made, not just the
current one.

Every registration starts `PENDING_REVIEW` **with withholding applied**. The
review is what clears it. That default is the safe one: withholding on an artist
who did file is a refund at tax time; not withholding on one who did not is an
IRS penalty against HitBox.

#### `POST /admin/tax/artist-documents/:documentId/review` — `manage:global`

`{ "decision": "APPROVE", "reason": "W-9 verified against IRS TIN match" }`

Approving a US W-9 is exactly the event that lifts backup withholding.

#### `GET /admin/tax/artist-documents/:documentId/download`

**120 seconds**, half the invoice TTL. A W-9 carries a taxpayer identification
number, and the window in which a leaked URL is useful should be about as long
as it takes to click it. Audited as `tax.artist-document.download`.

---

### 5.5 Filings and statements

Two quite different things share this surface, and the difference decides who
sees what:

| | Platform returns | Information returns |
| --- | --- | --- |
| Types | `GSTR_1`, `GSTR_3B`, `STATE_SALES_TAX` | `FORM_16A`, `FORM_1099_NEC` |
| About | HitBox's own sales, across every artist | One named artist's paid income |
| Artist may read | ❌ never | ✅ their own |

An artist-scoped caller is filtered to rows carrying their `artistId`, which no
GSTR row ever has. `GET /admin/tax/filings/:id` on a platform return refuses an
artist explicitly: *"This is HitBox's own tax return, not an artist statement."*

#### `POST /admin/tax/filings` — `manage:global`

```json
{ "filingType": "FORM_1099_NEC", "countryCode": "US",
  "periodStart": "2026-01-01T00:00:00Z", "periodEnd": "2027-01-01T00:00:00Z",
  "artistId": "…", "payoutId": "…" }
```

For `FORM_16A` and `FORM_1099_NEC` the payout gate applies — the payout must
exist, belong to the named artist, and be `PAID`:

> Form 16A and 1099-NEC report royalty that was *paid*; this payout is
> APPROVED. It becomes reportable once the transfer executes, and carries
> forward to the next cycle until then. — `TAX_PAYOUT_NOT_REPORTABLE`

Plus the separation-of-duties check in 4. Due dates are derived, not supplied:
GSTR-1 the 11th of the following month, GSTR-3B the 20th, 1099-NEC 31 January,
Form 16A 31 March.

#### `POST /admin/tax/filings/:filingId/file`

`{ "referenceNumber": "AA290926000123X", "filedAt": "…" }` — records the
government acknowledgement / ARN.

---

### 5.6 Reports — the data a return is filed from

#### `GET /admin/tax/reports/indirect-tax` — `payment-royalty:read:global`

`?countryCode=IN&periodStart=2026-09-01T00:00:00Z&periodEnd=2026-10-01T00:00:00Z`

Global only, enforced in the service: a GSTR-1 lists every seller's sales.

```json
{ "data": {
  "countryCode": "IN", "stateCode": null,
  "period": { "start": "…", "end": "…" },
  "invoiceCount": 412,
  "taxableValue": "1000000.00", "taxCollected": "120000.00", "grossValue": "1120000.00",
  "filingHint": "GSTR-1 table 12 (HSN-wise summary); GSTR-3B 3.1(a) output tax.",
  "byClassification": [
    { "code": "9706", "taxRate": "12.000", "quantity": 412,
      "taxableValue": "1000000.00", "taxAmount": "120000.00" }
  ]
} }
```

The HSN-wise breakdown is included unconditionally, because GSTR-1 requires it
and producing it separately would invite the two being run over different date
ranges. `VOID` invoices are excluded; `CORRECTED` ones are **not** — a corrected
invoice was issued and reported, and the correction is a separate line in the
trail, not an erasure.

#### `GET /admin/tax/reports/export` — `reports-dashboards:export:global`

The same summary plus one row per invoice, in the shape a GSTR-1 upload or a
state return wants. A separate capability because this copies customer names and
addresses out of the platform.

#### `GET /admin/tax/reports/form-1099-nec` — `payment-royalty:read`

`?artistId=…&taxYear=2026`. Box 1 sums **paid** USD payouts only, and reports
whether the $600 threshold is met.

```json
{ "data": {
  "artistId": "…", "taxYear": 2026, "currency": "USD",
  "box1Royalties": "1900.00", "payoutCount": 4,
  "threshold": "600.00", "reportable": true,
  "reason": "Above the $600 annual threshold — a 1099-NEC is required.",
  "payouts": [{ "payoutId": "…", "amount": "400.00", "paidAt": "2026-01-15T…" }]
} }
```

An artist calling this for another artist's id is refused. This method never
reads the royalty ledger — see [compliance-mapping.md 8](compliance-mapping.md#8-the-2026-09-15-business-logic-changes).

#### `GET /admin/tax/reports/form-16a` — `payment-royalty:read`

`?artistId=…&periodStart=…&periodEnd=…`. TDS at 30% (s.194O) on the paid INR
payouts — gross, deducted and net, which is exactly the three figures the
certificate carries.

---

### 5.7 Adjustments — correcting an issued figure

#### `POST /admin/tax/adjustments` — `manage:global`

`{ "invoiceId": "…", "adjustmentType": "TAX_CORRECTION", "reason": "…", "adjustedTaxAmount": "180.00" }`

Always created `PENDING_APPROVAL`. A correction to a figure already reported to
a tax authority is never self-service, even for the operator who spotted it.

#### `POST /admin/tax/adjustments/:adjustmentId/decide` — `override:global`

`{ "decision": "APPROVE", "reason": "Rate confirmed at 9% with the consultant" }`

Refused if the caller raised it (4). **The invoice row is not rewritten** — the
issued document stays as issued, and this entry is the correction. A tax
authority reading the trail sees both what was filed and what changed.

---

## 6. Errors

All responses use the platform envelope: `{ "error": { "code", "message", "details" } }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `TAX_NOT_FOUND` | 404 | No such record — or a buyer asking for someone else's invoice |
| `TAX_FORBIDDEN` | 403 | Grant does not reach this record or this power |
| `TAX_NO_CONFIGURATION` | 400 | No rate configured for the jurisdiction at that date |
| `TAX_ORDER_NOT_INVOICEABLE` | 400 | Order is not settled |
| `TAX_INVOICE_EXISTS` | 409 | (Not raised on the normal path — issue is idempotent) |
| `TAX_IMMUTABLE` | 409 | Attempt to edit an issued record |
| `TAX_INVALID_TRANSITION` | 409 | Already void / already filed / overlapping rate window |
| `TAX_SUPPLIER_NOT_CONFIGURED` | 400 | No supplier profile for the jurisdiction (or no GSTIN for `IN`) |
| `TAX_STORAGE_UNAVAILABLE` | 400 | No bucket configured on this deployment |
| `TAX_DOCUMENT_NOT_RENDERED` | 404 | The record has no stored file |
| `TAX_PAYOUT_NOT_REPORTABLE` | 400 | Filing requested against a payout that is not `PAID` |
| `TAX_SEPARATION_OF_DUTIES` | 403 | Caller approved/raised the thing they are trying to file/approve |

---

## 7. Audit

Every write is audited, and so is every **document read**.

| Event | Raised by |
| --- | --- |
| `tax.invoice.issue` | Issue, manual or from settlement |
| `tax.invoice.void` | Void |
| `tax.invoice.download` | Presigned download issued |
| `tax.configuration.change` | Rate created or closed |
| `tax.adjustment.approve` | Adjustment raised or decided |
| `tax.filing.create` / `tax.filing.file` | Filing created / lodged |
| `tax.artist-document.review` | Document registered or reviewed |
| `tax.artist-document.download` | Presigned download issued |

Events published on the bus, for other modules to react to:
`tax.invoice.issued`, `tax.invoice.document.stored`, `tax.invoice.voided`,
`tax.adjustment.approved`, `tax.filing.filed`,
`tax.artist-document.reviewed`.
