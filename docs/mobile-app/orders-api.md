# Orders — API

The buyer's own orders. This API feeds the **My orders** list (with its tabs),
the **Order detail** screen (status stepper, buttons, refund state), the
**Track parcel** screen and the **Cancel order** button on an unpaid order.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/orders` | Bearer | My orders, with tabs and badge counts |
| GET | `/orders/recent-purchases` | Bearer | Did I buy anything in the last 24 hours? The orders and the drops |
| GET | `/orders/:orderId` | Bearer | Full order detail, plus which buttons to show (`actions`) |
| GET | `/orders/:orderId/tracking` | Bearer | Carrier, tracking number and status timeline |
| POST | `/orders/:orderId/cancel` | Bearer | Cancel an **unpaid** order |

Base path: `/api/v1/orders`. Code: `packages/orders` (`BuyerOrderController`,
`BuyerOrderService`, `dto/buyer-order.dto.ts`).

Placing an order and paying for it are **not** in this router. They live in the
payments module: see [payments-api.md](payments-api.md).

---

## Purchase flow

From the **Buy Now** button to the receipt. Each step names the file that
documents it.

| # | App step | Call | Doc |
|---|---|---|---|
| 1 | App start: learn the markets (currencies) | `GET /markets` (public) → pick the buyer's `marketId` | [payments-api.md](payments-api.md#get-apiv1markets) |
| 2 | Checkout sheet: pick or add shipping and billing addresses | `GET /users/me/addresses`, `POST /users/me/addresses` | [addresses-api.md](addresses-api.md) |
| 3 | Show the price: variant, tax, total, in stock? Re-call when variant, market or address changes | `POST /checkout/quote` → `totalAmount` is what the card will be charged | [payments-api.md](payments-api.md#post-apiv1checkoutquote) |
| 4 | Buyer taps **Buy Now**, accepts terms | `POST /checkout` (same `variantId`, `marketId`, address ids) → creates the order (`PENDING_PAYMENT`), holds one numbered piece for 15 min, returns a Stripe `clientToken`. A taxed drop with no billing address is refused with `PAYMENTS_BILLING_ADDRESS_REQUIRED` | [payments-api.md](payments-api.md#post-apiv1checkout) |
| 5 | Show Stripe's payment sheet with `clientToken` (cards, **Apple Pay**, **Google Pay**) | Stripe SDK (no HitBox call) | [payments-api.md](payments-api.md#paying-with-stripe) |
| 6 | App was killed / sheet dismissed before paying | `POST /checkout/:orderId/resume` → same order, same charge, fresh `clientToken` | [payments-api.md](payments-api.md#post-apiv1checkoutorderidresume) |
| 7 | Wait for the result | Poll `GET /orders/:orderId` until `status` leaves `PENDING_PAYMENT` | this file |
| 8 | Changed their mind before paying | `POST /orders/:orderId/cancel` | this file |
| 9 | Order is `PAID` → `PROCESSING` → `SHIPPED` → `DELIVERED` | `GET /orders/:orderId`, `GET /orders/:orderId/tracking` | this file |
| 10 | Receipt | `GET /invoices/:invoiceId/download` (id from `invoice.id` on the detail) | [invoices-api.md](invoices-api.md) |
| 11 | Something wrong (or cancel after paying) | `POST /refunds` | [payments-api.md](payments-api.md#post-apiv1refunds) |

What the buyer pays is the same number in four places: the quote's `totalAmount`,
the checkout's `amount`, the order's `amount`, and the invoice's `totalAmount`
(prices are tax-inclusive: [payments-api.md](payments-api.md#how-the-charge-relates-to-the-invoice)).

The key rule: **the app never decides that an order is paid.** Stripe tells the
server through a webhook, and the server moves the order to `PAID`. After the
payment sheet reports success, the app shows "Confirming payment…" and polls
`GET /orders/:orderId`.

---

## Authentication

Every endpoint needs a signed-in user: the Clerk session JWT as
`Authorization: Bearer <token>`. See [auth-api.md](auth-api.md).

The caller also needs `order:read` (reads) or `order:create` (cancel). Every
buyer holds both at `own` scope, so a missing grant (`403 AUTHZ_FORBIDDEN`)
means the account is misconfigured, not that the user did something wrong.

All calls are keyed on the caller's own id. **Someone else's order is a `404
ORDERS_NOT_FOUND`**, the same answer as an order that does not exist.

---

## Shapes

Money is always a **decimal string** in the order's own currency (`"2499.00"`).
Dates are ISO-8601 UTC strings.

### `BuyerOrderListItem`: one row on "My orders"

```jsonc
{
  "id": "8c1e2f6a-4b1d-4c55-9a3e-1f2b3c4d5e6f",
  "reference": "odr0kz3m9q",          // short code to show and quote to support; null on old orders
  "status": "SHIPPED",                // see "Order statuses" below
  "statusLabel": "Shipped",           // English label from the API
  "placedAt": "2026-10-20T09:00:00.000Z",
  "deliveredAt": null,
  "product": {
    "id": "5d0b9e1c-…",               // drop id → GET /products/:id
    "name": "Kaze — Neon Nights Tour Tee",
    "code": "KZ-NN",                  // the drop's group code
    "imageUrl": "https://cdn…/drop-images/….png", // null when no image
    "artistName": "Kaze"              // null when the drop has no artist
  },
  "variantLabel": "M / Black",        // null for a drop without variants
  "quantity": 1,                      // always 1 today
  "amount": "2499.00",
  "currency": "INR",
  "tracking": {                       // null until shipped
    "carrierName": "Delhivery",
    "trackingNumber": "14900000000123",
    "trackingUrl": null               // https link when the carrier has one
  },
  "refundInProgress": false           // true while a refund is REQUESTED / AWAITING_RETURN / APPROVED
}
```

### `BuyerOrderDetail`: the order screen

All list-item fields except `tracking` and `refundInProgress` (both replaced
below), plus:

```jsonc
{
  // …id, reference, status, statusLabel, placedAt, deliveredAt, product,
  //   variantLabel, quantity, amount, currency (as in the list item)
  "paidAt": "2026-10-20T09:03:12.000Z",
  "shippedAt": "2026-10-21T14:00:00.000Z",
  "variant": {                        // null for a drop without variants
    "id": "c3a1…",
    "label": "M / Black",
    "options": [
      { "dimension": "Size",   "value": "M",     "hexCode": null },
      { "dimension": "Colour", "value": "Black", "hexCode": "#000000" }
    ]
  },
  "unit": {                           // null until a packer scans the numbered piece
    "skuCode": "KZ-NN-0014",
    "serialNumber": 14,               // "#14 of 200"
    "claimed": false,                 // the buyer tapped the tag and owns it
    "claimedAt": null
  },
  "unitPrice": "2499.00",
  "shippingAddress": BuyerAddress | null,
  "billingAddress":  BuyerAddress | null,
  "payment": {
    "status": "PAID",                 // AWAITING_PAYMENT | PAID | FAILED | REFUNDED | CANCELLED
    "paidAt": "2026-10-20T09:03:12.000Z",
    "payBy": null,                    // while AWAITING_PAYMENT: when the held piece is released
    "failureReason": null             // last declined attempt's reason ("Your card was declined.")
  },
  "refunds": [ BuyerOrderRefund ],    // newest first; [] when none
  "tracking": {                       // null until shipped
    "carrierName": "Delhivery",
    "trackingNumber": "14900000000123",
    "trackingUrl": null,
    "shippedAt": "2026-10-21T14:00:00.000Z",
    "deliveredAt": null,
    "deliveredVia": null              // "ADMIN" | "NFC_CLAIM" | null
  },
  "timeline": [                       // one entry per status reached, oldest first
    { "status": "PENDING_PAYMENT", "at": "2026-10-20T09:00:00.000Z" },
    { "status": "PAID",            "at": "2026-10-20T09:03:12.000Z" },
    { "status": "PROCESSING",      "at": "2026-10-21T10:30:00.000Z" },
    { "status": "SHIPPED",         "at": "2026-10-21T14:00:00.000Z" }
  ],
  "invoice": {                        // null until an invoice is issued
    "id": "e7f2…",                    // → GET /invoices/:invoiceId/download
    "number": "INV-2026-27-IN-001234",
    "date": "2026-10-20T09:03:15.000Z",
    "totalAmount": "2499.00",
    "currency": "INR"
  },
  "actions": BuyerOrderActions
}
```

`payment.status` is derived from the order status:

| Order `status` | `payment.status` |
|---|---|
| `PENDING_PAYMENT` | `AWAITING_PAYMENT` |
| `PAID`, `PROCESSING`, `SHIPPED`, `DELIVERED` | `PAID` |
| `REFUNDED` | `REFUNDED` |
| `CANCELLED` | `REFUNDED` if it had been paid, else `FAILED` if a charge failed, else `CANCELLED` |

### `BuyerAddress`

A copy taken at checkout. It does not change when the buyer edits or deletes
the saved address in their address book ([addresses-api.md](addresses-api.md)),
which also carries `id`, `label`, `isDefault`, `usage` and `createdAt` that this
copy does not.

```jsonc
{
  "recipientName": "Arjun Singh",
  "line1": "12 MG Road",
  "line2": "Flat 4B",                 // null if not set
  "city": "Bengaluru",
  "state": "KA",                      // null if not set
  "postalCode": "560001",
  "countryCode": "IN",
  "phone": "+919800000000"            // null if not set
}
```

### `BuyerOrderRefund`: one entry in `refunds[]`

```jsonc
{
  "id": "4b2d…",                      // → GET /refunds/:refundId for the photos
  "status": "AWAITING_RETURN",        // REQUESTED | AWAITING_RETURN | APPROVED | PROCESSED | REJECTED
  "statusLabel": "Waiting for your return",
  "reasonCode": "DEFECTIVE_ITEM",
  "reason": "The print is peeling after the first wash.",
  "amount": "2499.00",                // null only on very old rows
  "currency": "INR",
  "requestedAt": "2026-10-25T08:00:00.000Z",
  "returnRequired": true,             // the item must come back before approval
  "returnReceivedAt": null,           // set when the warehouse receives it
  "photoCount": 2,
  "rejectionReason": null,            // set when REJECTED
  "processedAt": null,                // when HitBox sent the money; banks take 5–10 business days after this
  "failed": false                     // true: Stripe reported the refund failed; support will contact the buyer
}
```

| `status` | `statusLabel` |
|---|---|
| `REQUESTED` | Refund requested |
| `AWAITING_RETURN` | Waiting for your return |
| `APPROVED` | Refund approved |
| `PROCESSED` | Refunded |
| `REJECTED` | Refund declined |

### `BuyerOrderActions`: which buttons to show

```jsonc
{
  "canCancel": false,                 // → POST /orders/:orderId/cancel
  "canResumePayment": false,          // → POST /checkout/:orderId/resume
  "canRequestRefund": true,           // → POST /refunds
  "refundBlockedReason": null,        // why not, when canRequestRefund is false
  "returnWindowEndsAt": "2026-11-04T12:00:00.000Z", // null until delivered
  "canTrack": true,                   // a shipment exists
  "canDownloadInvoice": true          // an invoice exists → invoice.id
}
```

| Flag | True when | Button |
|---|---|---|
| `canCancel` | `status = PENDING_PAYMENT` | **Cancel order** |
| `canResumePayment` | `PENDING_PAYMENT` and the stock hold has not expired | **Complete payment** (countdown from `payment.payBy`) |
| `canRequestRefund` | see [refund rules](payments-api.md#refund-rules) | **Request a refund** / **Cancel & refund** if not shipped |
| `canTrack` | a shipment is recorded | **Track parcel** |
| `canDownloadInvoice` | an invoice exists | **Download invoice** |

`refundBlockedReason` is one of `ORDER_NOT_REFUNDABLE`, `REFUND_IN_PROGRESS`,
`RETURN_WINDOW_CLOSED`, `FULLY_REFUNDED`.

---

## Endpoints

### `GET /api/v1/orders`

"My orders", newest `placedAt` first.

| Param | Values | Default |
|---|---|---|
| `tab` | `all` `active` `completed` `cancelled` | `all` |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `10` |

| `tab` | Statuses |
|---|---|
| `all` | everything |
| `active` | `PENDING_PAYMENT`, `PAID`, `PROCESSING`, `SHIPPED` |
| `completed` | `DELIVERED` |
| `cancelled` | `CANCELLED`, `REFUNDED` |

**This response has no `data` envelope.** The list fields sit at the top level:

```jsonc
{
  "page": 1,
  "limit": 10,
  "total": 7,                         // rows in the selected tab
  "counts": { "all": 9, "active": 3, "completed": 4, "cancelled": 2 }, // every tab, always
  "items": [ BuyerOrderListItem, … ]
}
```

Use `counts` for the tab badges. It always has every tab, whichever tab you asked for.

Errors: `422 VALIDATION_ERROR` for a bad `tab`, `page` or `limit`.

### `GET /api/v1/orders/recent-purchases`

"Did I buy anything lately?" The paid orders of the last **24 hours** (or
`hours`), and the drops they were for. Use it for a "thanks for your order" or
"your purchase from today" banner, or to decide whether to show a prompt such as
"tap your piece to claim it".

| Param | Values | Default |
|---|---|---|
| `hours` | int 1–168, how far back to look | `24` |

**What counts as a purchase.** An order whose payment settled (`paidAt`) inside
the window and that is still standing: status `PAID`, `PROCESSING`, `SHIPPED` or
`DELIVERED`. These do **not** count: an unpaid checkout (`PENDING_PAYMENT`), a
`CANCELLED` order, a `REFUNDED` order. The window runs from `paidAt`, not from when
the order was placed, so a checkout started yesterday and paid ten minutes ago
counts. Only your own orders are ever returned.

```jsonc
{
  "data": {
    "hasPurchased": true,                  // false when nothing was bought in the window
    "windowHours": 24,
    "since": "2026-11-27T12:00:00.000Z",   // start of the window
    "count": 2,                            // paid orders in the window
    "purchases": [                         // newest payment first; [] when none
      {
        "orderId": "5d0c…",                // GET /orders/:orderId for the full detail
        "reference": "odr0abc",
        "status": "PAID",
        "statusLabel": "Order confirmed",
        "paidAt": "2026-11-28T09:12:00.000Z",
        "drop": {
          "id": "6f1c…",                   // GET /products/:id
          "name": "Neon Nights Tour Tee",
          "code": "KZ-NN",
          "imageUrl": "https://…",         // null if the drop has no image
          "artistName": "Kaze"
        },
        "variantLabel": "M / Black",       // null for a drop without variants
        "quantity": 1,
        "amount": "2499.00",
        "currency": "INR"
      }
    ],
    "drops": [                             // each drop once, most recently bought first; [] when none
      {
        "id": "6f1c…", "name": "Neon Nights Tour Tee", "code": "KZ-NN",
        "imageUrl": "https://…", "artistName": "Kaze",
        "purchaseCount": 1,                // paid orders for this drop in the window
        "lastPurchasedAt": "2026-11-28T09:12:00.000Z"
      }
    ]
  }
}
```

Nothing bought is **not** an error: it is `200` with `hasPurchased: false`,
`count: 0` and empty `purchases` and `drops`.

Errors: `401` without a session; `422 VALIDATION_ERROR` for an `hours` outside 1-168
or not a number.

> The route is `/orders/recent-purchases`; it is declared before `/orders/:orderId`
> so it is never read as an order id.

### `GET /api/v1/orders/:orderId`

```jsonc
{ "data": BuyerOrderDetail }
```

Errors: `404 ORDERS_NOT_FOUND` (no such order, or not yours).

### `GET /api/v1/orders/:orderId/tracking`

The tracking part of the detail on its own, for a light refresh.

```jsonc
{
  "data": {
    "orderId": "8c1e2f6a-…",
    "status": "SHIPPED",
    "placedAt": "2026-10-20T09:00:00.000Z",
    "paidAt": "2026-10-20T09:03:12.000Z",
    "shippedAt": "2026-10-21T14:00:00.000Z",
    "deliveredAt": null,
    "shipment": {                     // null until shipped
      "carrierName": "Delhivery",
      "trackingNumber": "14900000000123",
      "trackingUrl": null,
      "shippedAt": "2026-10-21T14:00:00.000Z",
      "deliveredAt": null,
      "deliveredVia": null
    },
    "timeline": [ { "status": "PENDING_PAYMENT", "at": "…" }, { "status": "SHIPPED", "at": "…" } ]
  }
}
```

HitBox has no fixed logistics partner and no live parcel-scan feed:

- show `carrierName` and `trackingNumber` with a **copy** button;
- if `trackingUrl` is set, **Track parcel** opens it;
- `deliveredVia: "NFC_CLAIM"` → "Delivered: you tapped your item"; `"ADMIN"` → "Delivered".

Errors: `404 ORDERS_NOT_FOUND`.

### `POST /api/v1/orders/:orderId/cancel`

Cancel an order **before paying**. The held piece goes straight back on sale.

Body (optional, may be empty `{}`):

| Field | Rules |
|---|---|
| `reason` | string, trimmed, max 500 chars, optional |

```json
{ "reason": "Picked the wrong size" }
```

Returns the updated order:

```jsonc
{ "data": BuyerOrderDetail }          // status "CANCELLED"
```

Tapping twice is safe: an already-cancelled order is returned as-is.

| Status | Code | When |
|---|---|---|
| 400 | `ORDERS_CANCEL_REQUIRES_REFUND` | The order is already paid. Use `POST /refunds` instead; `details.status` has the current status |
| 409 | `ORDERS_INVALID_TRANSITION` | The payment landed a moment before the cancel. Reload; the order is paid |
| 404 | `ORDERS_NOT_FOUND` | No such order, or not yours |
| 422 | `VALIDATION_ERROR` | `reason` over 500 chars |

### Errors common to all endpoints

Auth errors (`401 AUTH_*`, `403 AUTH_ACCOUNT_SUSPENDED`) are listed in
[auth-api.md](auth-api.md). Every error uses the shared envelope
`{ "error": { "code", "message", "details" } }`; see
[../api-reference.md](../api-reference.md).

---

## How it works

### Order statuses

| `status` | `statusLabel` | Means |
|---|---|---|
| `PENDING_PAYMENT` | Awaiting payment | Placed, a piece is held, payment not confirmed |
| `PAID` | Order confirmed | Stripe confirmed the money; waiting to be packed |
| `PROCESSING` | Being packed | A numbered piece was scanned for this order (`unit` is now set) |
| `SHIPPED` | Shipped | Handed to a carrier, with tracking |
| `DELIVERED` | Delivered | Confirmed by HitBox, or the buyer tapped the NFC tag |
| `CANCELLED` | Cancelled | Never paid: cancelled by the buyer, payment failed, or time ran out |
| `REFUNDED` | Refunded | Money returned |

```
PENDING_PAYMENT ──(webhook: paid)──▶ PAID ──▶ PROCESSING ──▶ SHIPPED ──▶ DELIVERED
      │                                │           │             │           │
      │ buyer cancel / payment failed  └───────────┴──── refund processed ───┴──▶ REFUNDED
      │ / time ran out
      ▼
  CANCELLED
```

- **Only the server moves an order forward.** `PAID` comes from the Stripe
  webhook. `PROCESSING` and `SHIPPED` come from the warehouse. `DELIVERED` comes
  from HitBox staff or from the buyer tapping the item's NFC tag (a `SHIPPED`
  order then becomes `DELIVERED` at once).
- **The buyer can only cancel an unpaid order.** Once paid, "cancel" means a
  refund, because the money has to go back.
- `CANCELLED` and `REFUNDED` are final.

### Stock hold and expiry

1. `POST /checkout` holds the lowest-numbered free piece for
   **15 minutes** (`INVENTORY_HOLD_SECONDS`, default 900). Nobody else can buy it.
2. `payment.payBy` shows when the hold ends. `canResumePayment` turns false then.
3. When the hold expires, the piece goes back on sale. The order stays
   `PENDING_PAYMENT` for another **30 minutes** (`UNPAID_ORDER_GRACE_SECONDS`),
   so a slow card payment (3-D Secure) can still settle if nobody took the piece.
4. After that a server sweep (every 60 s) cancels the order.
5. Cancelling yourself (`POST /orders/:orderId/cancel`) releases the hold at once.

If a late payment arrives after someone else bought the piece, the money is
parked for HitBox staff to review and refund. The order stays unpaid and is
then cancelled.

### Refund state on the order

Refunds are requested through payments (`POST /refunds`). The order shows them
in `refunds[]` and `refundInProgress`. Only one refund can be open at a time.
The order moves to `REFUNDED` when HitBox processes the refund. Full rules:
[payments-api.md → How it works](payments-api.md#how-it-works).

### The return window

A delivered order can be returned for **10 days** (`RETURN_WINDOW_DAYS`) after
`deliveredAt`. `actions.returnWindowEndsAt` gives the exact end ("Return by
4 Nov"). After it, the buyer cannot request any refund on that order
(`refundBlockedReason: "RETURN_WINDOW_CLOSED"`). Before delivery, no window is
running.

---

## Known limitations

- **One item per order.** Every piece is numbered and an order carries one unit,
  so `quantity` is always `1`. There is no cart.
- **No live parcel tracking.** Only the carrier's name, number and link.
- **The list has no `data` envelope** (`{ page, limit, total, counts, items }`),
  unlike the other list endpoints.
- **Recent purchases counts paid orders only.** A checkout that is still unpaid, and an order that
  was cancelled or refunded, are not purchases. A paid order that is refunded later drops out
  of the next call.
- **Recent purchases is capped at 100 orders** in one window; it is not paginated.
- **`statusLabel` is English.** Translate on the client if needed.
- **The invoice appears a moment after payment.** It is issued when Stripe's
  webhook confirms the payment, not inside the checkout call. Treat
  `invoice: null` as "not ready yet", not as an error.
