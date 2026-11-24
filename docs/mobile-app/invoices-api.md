# Invoices — API

The buyer's own tax invoices (receipts). This API feeds the **Download invoice**
button on the order screen and a **My invoices** / receipts list in the
account area.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/invoices` | Bearer | My invoices, newest first |
| GET | `/invoices/:invoiceId` | Bearer | One invoice: number, amounts, tax, line items |
| GET | `/invoices/:invoiceId/download` | Bearer | A 5-minute link to the invoice PDF |

These paths sit directly under `/api/v1` (the router is mounted at `/`), so the
full path is `/api/v1/invoices`. Code: `packages/tax` (`TaxController`
buyer handlers, `InvoiceService`, `dto/tax.dto.ts`).

This is the last step of the [purchase flow](orders-api.md#purchase-flow). The
order detail (`GET /orders/:orderId`) already carries a short `invoice` summary
with the `id` to use here.

---

## Authentication

Every endpoint needs a signed-in user: the Clerk session JWT as
`Authorization: Bearer <token>`. See [auth-api.md](auth-api.md).

The caller also needs `order:read`, which every buyer holds at `own` scope.
These routes **always** answer in buyer scope: even a finance operator sees only
their own purchases here. Someone else's invoice is a `404 TAX_NOT_FOUND`, never
a 403, so its existence is not revealed.

---

## Shapes

Every money value and every rate is a **string** (`"2499.00"`, `"12.000"`).
Never sum them as floats.

### `Invoice`

```jsonc
{
  "id": "e7f2a1b0-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "invoiceNumber": "INV-2026-27-IN-001234",  // INV-<fiscal year>-<country>-<6-digit sequence>
  "invoiceDate": "2026-10-20T09:03:15.000Z",
  "fiscalYear": "2026-27",                   // India: "2026-27"; US: "2026"
  "status": "ISSUED",                        // ISSUED | VOID | CORRECTED
  "orderId": "8c1e2f6a-…",                   // → GET /orders/:orderId
  "countryCode": "IN",                       // from the billing address
  "stateCode": "KA",                         // null when not applicable
  "currency": "INR",
  "taxType": "GST",                          // GST | SALES_TAX | EXEMPT
  "taxRate": "12.000",                       // percent
  "hsnCode": "9706",                         // product tax code; null if none
  "subtotal": "2231.25",                     // the price without tax
  "taxAmount": "267.75",
  "totalAmount": "2499.00",
  "pricesIncludeTax": true,                  // the price contained the tax, so totalAmount is what was charged. false on older invoices
  "supplier": {                              // HitBox's legal entity for this country
    "name": "HitBox Collectibles Pvt Ltd",
    "address": "…",
    "gstin": "29ABCDE1234F1Z5",              // India; null elsewhere
    "pan": "ABCDE1234F",                     // India; null elsewhere
    "ein": null                              // US; null elsewhere
  },
  "customer": {
    "name": "Arjun Singh",
    "email": "arjun@example.com",
    "address": "Arjun Singh\n12 MG Road\nBengaluru KA 560001\nIN", // billing address, lines joined by "\n"; null if none
    "gstin": null                            // always null today
  },
  "lineItems": [
    {
      "position": 1,
      "description": "Kaze — Neon Nights Tour Tee (M / Black)",
      "hsnCode": "6109",
      "sacCode": null,
      "quantity": 1,
      "unitPrice": "2231.25",
      "lineSubtotal": "2231.25",
      "taxRate": "12.000",
      "taxAmount": "267.75",
      "lineTotal": "2499.00"
    }
  ],
  "documentAvailable": true,                 // the PDF is already rendered; download works either way
  "notes": null,
  "issuedAt": "2026-10-20T09:03:15.000Z"
}
```

Buyers never see storage keys, file digests or other operator-only fields.

---

## Endpoints

### `GET /api/v1/invoices`

My invoices, newest `invoiceDate` first.

| Param | Values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–100 | `20` |
| `status` | `ISSUED` `VOID` `CORRECTED` | all |
| `countryCode` | 2 uppercase letters, e.g. `IN` | all |
| `stateCode` | 2 uppercase letters, e.g. `KA` | all |
| `fiscalYear` | string ≤ 10 chars, e.g. `2026-27` | all |
| `issuedFrom` | ISO date; `invoiceDate >= issuedFrom` | none |
| `issuedTo` | ISO date; `invoiceDate < issuedTo` | none |

`buyerId` in the query is ignored: your own id always wins.

```jsonc
{
  "data": [ Invoice, … ],
  "meta": { "page": 1, "limit": 20, "total": 3 }   // no totalPages: use ceil(total / limit)
}
```

Errors: `422 VALIDATION_ERROR` for a bad parameter (e.g. `countryCode=in`).

### `GET /api/v1/invoices/:invoiceId`

```jsonc
{ "data": Invoice }
```

| Status | Code | When |
|---|---|---|
| 404 | `TAX_NOT_FOUND` | No such invoice, or not yours |

### `GET /api/v1/invoices/:invoiceId/download`

A presigned link to the PDF, valid for **300 seconds**. The file comes straight
from storage. Open it in the system viewer or a share sheet right away; ask for
a new link each time instead of caching it.

```jsonc
{
  "data": {
    "url": "https://…s3…/invoices/…pdf?X-Amz-Signature=…",
    "expiresIn": 300,
    "invoiceNumber": "INV-2026-27-IN-001234"   // use for the file name
  }
}
```

If the PDF was never rendered (`documentAvailable: false`), it is rendered on
the spot, so this call can take a moment longer the first time.

| Status | Code | When |
|---|---|---|
| 404 | `TAX_NOT_FOUND` | No such invoice, or not yours |
| 400 | `TAX_STORAGE_UNAVAILABLE` | Document storage is not configured on this server. Hide the button |

Every download is audited (who fetched which invoice).

---

## How it works

### When an invoice exists

1. The order is paid (`PAID`, see [payments-api.md](payments-api.md)).
2. The server issues **one invoice per order**. Tax is due on the sale, not on
   placing the order or on claiming the item.
3. The order detail then shows `invoice` (not `null`) and
   `actions.canDownloadInvoice: true`.

Until then, show "Invoice will be available once your order is confirmed".

How it is triggered: when Stripe's webhook confirms the payment **and** the
order is marked `PAID`, payments publishes `payments.order.settled`, and the
tax module issues the invoice from it. Issuing is idempotent, so a repeated
webhook never creates a second invoice. If the payment settles but the order
cannot be marked paid (for example, the hold expired first), the payment is
parked for staff review and **no invoice is issued** until that is resolved.

### Which tax applies

The **billing address** country decides the rules: Indian GST for `IN`, US sales
tax for `US`. With no billing address, the currency is the fallback (`INR` → `IN`,
anything else → `US`). Checkout now **requires** a `billingAddressId` whenever the
sale is taxed (`PAYMENTS_BILLING_ADDRESS_REQUIRED`), so a new order always has the
right country. See [payments-api.md](payments-api.md#billing-address-rule).

**Prices include tax.** The invoice splits the price the buyer paid; it does not
add tax on top. Per line: `lineTotal` is the price paid, `lineSubtotal =
lineTotal ÷ (1 + taxRate)` rounded once, and `taxAmount = lineTotal − lineSubtotal`.
So `lineSubtotal + taxAmount = lineTotal` and the invoice `totalAmount` equals the
order's `amount`, the checkout's `amount` and the quote's `totalAmount`
([why](payments-api.md#how-the-charge-relates-to-the-invoice)).

### Invoice statuses

| `status` | Means | Show |
|---|---|---|
| `ISSUED` | The normal, final state | Download |
| `VOID` | Cancelled by HitBox; the number is kept and never reused | "Void" badge |
| `CORRECTED` | Replaced by a newer invoice for the same order | "Superseded" badge; show the newer one |

Issued invoices are never edited. A fix means a void or a new, corrected invoice.

---

## Known limitations

- **Issuing can fail quietly.** If the invoice cannot be generated (for
  example, missing tax configuration), the error is logged for staff, who
  issue it with `POST /admin/tax/invoices`. The order stays paid. Treat
  `invoice: null` on a paid order as "not ready yet".
- **Old invoices add tax on top.** Invoices issued before tax-inclusive pricing
  (`pricesIncludeTax: false`) treated the order's price as before tax, so their
  `totalAmount` can be higher than what was charged. They are never edited. New
  invoices (`pricesIncludeTax: true`) always equal the amount charged.
- **No `totalPages`** in the list `meta`.
- **A refund does not change the invoice the buyer sees.** Tax adjustments for refunds are staff-side records.
