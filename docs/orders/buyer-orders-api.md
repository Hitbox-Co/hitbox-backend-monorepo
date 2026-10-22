# Buyer orders API ("My orders")

Everything the **buyer app** needs for orders, in one place: placing an order,
paying, the orders list and detail, tracking, cancelling, refunds and invoices.
Every endpoint here works on the **signed-in buyer's own orders only**. Another
person's order returns `404`, exactly like an order that doesn't exist.

Staff-side order APIs live in the other docs in this folder
([order-history-and-shipments.md](order-history-and-shipments.md),
[order-payments-and-refunds-api.md](order-payments-and-refunds-api.md),
[order-unit-assignment-api.md](order-unit-assignment-api.md)).

All paths are under **`/api/v1`** and need a Clerk session (`Authorization: Bearer <token>`).
Buyers hold the `BUYER_COLLECTOR` role (`order:create:own`, `order:read:own`), which is all these need.
Errors return `{ "error": { "code", "message", "details" } }`.

---

## 1. All buyer order endpoints

| # | Method & path | What it's for | Module |
|---|---|---|---|
| 1 | `POST /checkout` | Place an order: holds one piece for 15 min and starts the payment | payments |
| 2 | `POST /checkout/:orderId/resume` | **New.** Back to paying for an unpaid order (closed the app, card declined) | payments |
| 3 | `GET /orders` | **New.** "My orders" list with tabs and badge counts | orders |
| 4 | `GET /orders/:orderId` | **New.** Full order detail, plus what the buyer can do next (`actions`) | orders |
| 5 | `GET /orders/:orderId/tracking` | Carrier, tracking number, link and timeline | orders |
| 6 | `POST /orders/:orderId/cancel` | **New.** Cancel an **unpaid** order | orders |
| 7 | `POST /refunds` | Request a refund. This is also how to cancel a **paid** order (**fixed** for buyers, see §8) | payments |
| 8 | `GET /invoices` | All my invoices | tax |
| 9 | `GET /invoices/:invoiceId` | One invoice | tax |
| 10 | `GET /invoices/:invoiceId/download` | Short-lived link to the invoice PDF | tax |

How a screen picks the right call: load the order detail (#4) and show
buttons from its **`actions`** object (§4.3). Every action that's `true` will
be accepted.

---

## 2. Order statuses, as the buyer sees them

| `status` | `statusLabel` | Means |
|---|---|---|
| `PENDING_PAYMENT` | Awaiting payment | Placed, the piece is held, payment not finished |
| `PAID` | Order confirmed | Paid, waiting to be packed |
| `PROCESSING` | Being packed | A numbered piece has been picked and scanned for this order |
| `SHIPPED` | Shipped | On its way, with tracking |
| `DELIVERED` | Delivered | Arrived (confirmed by HitBox, or the buyer tapped the NFC tag) |
| `CANCELLED` | Cancelled | Never paid (cancelled by the buyer, or payment time ran out) |
| `REFUNDED` | Refunded | Money returned |

`statusLabel` is English text the API provides so every client says the same
thing; translate on the client if needed.

**Tabs on "My orders":**

| `tab` | Statuses |
|---|---|
| `all` (default) | everything |
| `active` | `PENDING_PAYMENT`, `PAID`, `PROCESSING`, `SHIPPED` |
| `completed` | `DELIVERED` |
| `cancelled` | `CANCELLED`, `REFUNDED` |

---

## 3. `GET /orders`: my orders

| Query | Default | Notes |
|---|---|---|
| `tab` | `all` | `all`, `active`, `completed`, `cancelled` |
| `page` | `1` | |
| `limit` | `10` | max `50` |

Newest first.

```json
{
  "page": 1,
  "limit": 10,
  "total": 7,
  "counts": { "all": 9, "active": 3, "completed": 4, "cancelled": 2 },
  "items": [
    {
      "id": "8c1e2f6a-…",
      "reference": "odr0kz3m9q…",
      "status": "SHIPPED",
      "statusLabel": "Shipped",
      "placedAt": "2026-10-20T09:00:00.000Z",
      "deliveredAt": null,
      "product": {
        "id": "5d0b…", "name": "Kaze — Neon Nights Tour Tee", "code": "KZ-NN",
        "imageUrl": "https://cdn…/drop-images/….png", "artistName": "Kaze"
      },
      "variantLabel": "M / Black",
      "quantity": 1,
      "amount": "2499.00",
      "currency": "INR",
      "tracking": { "carrierName": "Delhivery", "trackingNumber": "14900000000123", "trackingUrl": null },
      "refundInProgress": false
    }
  ]
}
```

- `counts` always has every tab, whichever tab you asked for, so badges stay right.
- `reference` is the short order code to show the buyer and quote to support.
- `imageUrl` can be `null` (no image, or media not configured). Show a placeholder.
- `tracking` is `null` until the order ships.
- `refundInProgress` is `true` while a refund is requested, awaiting the return or approved.

---

## 4. `GET /orders/:orderId`: order detail

```json
{
  "data": {
    "id": "8c1e2f6a-…",
    "reference": "odr0kz3m9q…",
    "status": "SHIPPED",
    "statusLabel": "Shipped",
    "placedAt": "2026-10-20T09:00:00.000Z",
    "paidAt": "2026-10-20T09:01:10.000Z",
    "shippedAt": "2026-10-21T15:20:00.000Z",
    "deliveredAt": null,

    "product": { "id": "5d0b…", "name": "Kaze — Neon Nights Tour Tee", "code": "KZ-NN", "imageUrl": "https://cdn…", "artistName": "Kaze" },
    "variantLabel": "M / Black",
    "variant": {
      "id": "e7a1…",
      "label": "M / Black",
      "options": [
        { "dimension": "Size",   "value": "M",     "hexCode": null },
        { "dimension": "Colour", "value": "Black", "hexCode": "#000000" }
      ]
    },
    "unit": { "skuCode": "KZ-NN-000014", "serialNumber": 14, "claimed": false, "claimedAt": null },
    "quantity": 1,
    "unitPrice": "2499.00",
    "amount": "2499.00",
    "currency": "INR",

    "shippingAddress": {
      "recipientName": "Asha Rao", "line1": "12 MG Road", "line2": null, "city": "Bengaluru",
      "state": "KA", "postalCode": "560001", "countryCode": "IN", "phone": null
    },
    "billingAddress": { "…": "same shape" },

    "payment": { "status": "PAID", "paidAt": "2026-10-20T09:01:10.000Z", "payBy": null, "failureReason": null },

    "refunds": [],

    "tracking": {
      "carrierName": "Delhivery", "trackingNumber": "14900000000123",
      "trackingUrl": "https://…", "shippedAt": "2026-10-21T15:20:00.000Z",
      "deliveredAt": null, "deliveredVia": null
    },
    "timeline": [
      { "status": "PENDING_PAYMENT", "at": "2026-10-20T09:00:00.000Z" },
      { "status": "PAID",            "at": "2026-10-20T09:01:10.000Z" },
      { "status": "PROCESSING",      "at": "2026-10-21T11:02:00.000Z" },
      { "status": "SHIPPED",         "at": "2026-10-21T15:20:00.000Z" }
    ],

    "invoice": { "id": "c91d…", "number": "HB/2026-27/000123", "date": "2026-10-20T09:01:10.000Z", "totalAmount": "2499.00", "currency": "INR" },

    "actions": {
      "canCancel": false,
      "canResumePayment": false,
      "canRequestRefund": true,
      "refundBlockedReason": null,
      "canTrack": true,
      "canDownloadInvoice": true
    }
  }
}
```

### 4.1 Fields worth knowing

| Field | Notes |
|---|---|
| `variant.options[].hexCode` | Show a colour swatch when set |
| `unit` | The **numbered piece**: `serialNumber` 14 means "#14 of the edition". `null` until a packer has picked and scanned it, so no number is promised before packing |
| `unit.claimed` | The buyer has tapped the NFC tag and owns the piece on the provenance ledger |
| `payment.status` | `AWAITING_PAYMENT`, `PAID`, `FAILED`, `REFUNDED`, `CANCELLED` |
| `payment.payBy` | While awaiting payment: when the held piece is released. Show a countdown |
| `payment.failureReason` | The last declined attempt's reason, while unpaid ("Your card was declined") |
| `refunds[]` | Newest first (§4.2) |
| `tracking` | Same as `GET …/tracking` (§5). `null` until shipped |
| `timeline` | One entry per status reached, oldest first. Use it for a progress stepper |
| `invoice` | `null` until issued (it's issued when payment settles). Download via `GET /invoices/:id/download` |

### 4.2 Refunds on the order

```json
{
  "id": "2843…", "status": "AWAITING_RETURN", "statusLabel": "Waiting for your return",
  "reasonCode": "DEFECTIVE_ITEM", "reason": "Print is peeling", "amount": "2499.00", "currency": "INR",
  "requestedAt": "2026-10-25T08:00:00.000Z", "returnRequired": true, "returnReceivedAt": null,
  "rejectionReason": null, "processedAt": null, "failed": false
}
```

| `status` | `statusLabel` | Tell the buyer |
|---|---|---|
| `REQUESTED` | Refund requested | We're reviewing it |
| `AWAITING_RETURN` | Waiting for your return | Send the item back. `returnReceivedAt` fills in when it arrives |
| `APPROVED` | Refund approved | Money is about to be sent |
| `PROCESSED` | Refunded | Sent on `processedAt`. Banks usually take 5–10 business days |
| `REJECTED` | Refund declined | Show `rejectionReason` |

`failed: true` means the payment provider couldn't return the money (for example,
the card was closed). Show "There was a problem returning your money — our team
will contact you."

### 4.3 `actions`: which buttons to show

| Action | Button | Call |
|---|---|---|
| `canResumePayment` | **Complete payment** (with the `payBy` countdown) | `POST /checkout/:orderId/resume` (§6) |
| `canCancel` | **Cancel order** | `POST /orders/:orderId/cancel` (§7) |
| `canRequestRefund` | **Request a refund** / **Cancel & refund** if it hasn't shipped | `POST /refunds` (§8) |
| `canTrack` | **Track parcel** | `tracking` is already in the detail; or `GET …/tracking` |
| `canDownloadInvoice` | **Download invoice** | `GET /invoices/:invoice.id/download` |

When `canRequestRefund` is `false`, `refundBlockedReason` says why:

| `refundBlockedReason` | Show |
|---|---|
| `ORDER_NOT_REFUNDABLE` | Nothing. Unpaid, cancelled or already refunded |
| `REFUND_IN_PROGRESS` | "A refund is already in progress" (see `refunds[0]`) |
| `FULLY_REFUNDED` | "Refunded" |

---

## 5. `GET /orders/:orderId/tracking`

The tracking part of the detail on its own, for a lightweight tracking screen
or a refresh.

```json
{
  "data": {
    "orderId": "8c1e…", "status": "SHIPPED",
    "placedAt": "…", "paidAt": "…", "shippedAt": "…", "deliveredAt": null,
    "shipment": {
      "carrierName": "Delhivery", "trackingNumber": "14900000000123", "trackingUrl": null,
      "shippedAt": "…", "deliveredAt": null, "deliveredVia": null
    },
    "timeline": [{ "status": "PENDING_PAYMENT", "at": "…" }, { "status": "SHIPPED", "at": "…" }]
  }
}
```

HitBox has **no fixed logistics partner**. The carrier is whichever one shipped
this parcel, and there's no live parcel-scan feed. So:

- show `carrierName` and `trackingNumber` with a **copy** button;
- if `trackingUrl` is set, a **Track parcel** button opens it (it's always `https://`);
- if not, tell the buyer to enter the number on the carrier's website;
- `deliveredVia`: `NFC_CLAIM` means "Delivered: you tapped your item"; `ADMIN` means "Delivered".

**Tapping the tag marks a shipped order delivered.** When the buyer taps the
item's NFC tag to claim it, a `SHIPPED` order becomes `DELIVERED` immediately.

---

## 6. `POST /checkout/:orderId/resume`: complete payment

No body. For an order that is `PENDING_PAYMENT` whose held piece hasn't been
released yet (`actions.canResumePayment`).

Returns the **same** response as `POST /checkout`, for the **same** order,
held piece and payment:

```json
{
  "data": {
    "orderId": "8c1e…", "paymentTransactionId": "f1a0…", "skuId": "…", "reservationId": "…",
    "reservationExpiresAt": "2026-10-23T10:15:00.000Z",
    "amount": "30.00", "currency": "USD", "gateway": "STRIPE",
    "status": "PENDING", "clientToken": "pi_…_secret_…", "gatewayRef": "pi_…"
  }
}
```

Use `clientToken` with Stripe's payment sheet exactly as after checkout. This
can never create a second charge: it returns the original payment attempt.
`clientToken` is `null` on a deployment without the Stripe adapter.

| Error | When | Show |
|---|---|---|
| `409 PAYMENTS_RESERVATION_EXPIRED` | Payment time ran out and the piece was released | "Time ran out. Start again" → new checkout |
| `409 PAYMENTS_ORDER_NOT_PAYABLE` | Already paid, or cancelled | Reload the order |
| `404 PAYMENTS_NOT_FOUND` | Not your order | |

---

## 7. `POST /orders/:orderId/cancel`: cancel an unpaid order

```json
{ "reason": "Changed my mind" }
```

`reason` is optional. Only for `PENDING_PAYMENT` orders (`actions.canCancel`).
The held piece is released straight away for the next buyer. The order
becomes `CANCELLED` and the response is the updated detail (§4). Cancelling an
already-cancelled order just returns it.

| Error | When | Show |
|---|---|---|
| `400 ORDERS_CANCEL_REQUIRES_REFUND` | The order is paid | Offer **Request a refund** instead (§8) |
| `409 ORDERS_INVALID_TRANSITION` | The payment went through at that exact moment | "Your payment just went through", then reload |
| `404 ORDERS_NOT_FOUND` | Not your order | |

Unpaid orders are also cancelled automatically about 30 minutes after their
payment time runs out ([checkout-sweep.md](checkout-sweep.md)).

---

## 8. `POST /refunds`: request a refund (or cancel a paid order)

```json
{
  "orderId": "8c1e…",
  "reasonCode": "DEFECTIVE_ITEM",
  "reason": "The print is peeling after the first wash.",
  "physicalReturnRequired": true
}
```

| Field | Notes |
|---|---|
| `reasonCode` | `DEFECTIVE_ITEM`, `DEFECTIVE_TAG`, `NOT_AS_DESCRIBED`, `NOT_DELIVERED`, `DUPLICATE_CHARGE`, `BUYER_CHANGED_MIND`, `FRAUDULENT_CHARGE`, `OTHER` |
| `reason` | Required, up to 1000 characters |
| `amount` | Optional. Defaults to the full order amount |
| `physicalReturnRequired` | Default `true`. Send **`false` when the order hasn't shipped** (`PAID` / `PROCESSING`). This is the "cancel a paid order" case, and the piece goes straight back on sale once the refund is processed |

Allowed when `actions.canRequestRefund` is true. Returns `201` with the refund.
After that, follow it through `refunds[]` on the order detail. HitBox staff
review, receive the return and process it
([order-payments-and-refunds-api.md](order-payments-and-refunds-api.md)).

| Error | When |
|---|---|
| `400 PAYMENTS_NOT_REFUNDABLE` | Order isn't paid, shipped or delivered |
| `409 PAYMENTS_INVALID_TRANSITION` | A refund is already in progress |
| `400 PAYMENTS_AMOUNT_EXCEEDS_CAPTURE` | More than was paid |

> **Fixed in this change:** buyers hold no payment permission, so this endpoint
> used to answer `403` to every buyer. A buyer now resolves to "own orders
> only" access with no staff powers; staff payment routes are unaffected.

---

## 9. Invoices

Issued automatically when payment settles. Owned by the tax module; full
detail in [tax/api-reference.md](../tax/api-reference.md).

| Call | Returns |
|---|---|
| `GET /invoices` | My invoices (paginated) |
| `GET /invoices/:invoiceId` | One invoice (number, date, amounts, tax) |
| `GET /invoices/:invoiceId/download` | A short-lived download URL for the PDF |

The order detail already carries `invoice.id`, so the order screen can go
straight to the download.

---

## 10. Typical buyer flows

**Buy something**
1. `POST /checkout`: pay with `clientToken`.
2. The app closed or the card was declined? Open the order (`GET /orders/:id`) and use `canResumePayment` → `POST /checkout/:id/resume`.
3. Payment confirmed (by webhook): the order shows `PAID`, and `invoice` appears.

**Follow an order**
`GET /orders?tab=active` → `GET /orders/:id`. The stepper comes from `timeline`,
and the parcel from `tracking`.

**Changed my mind**
- Not paid yet: `POST /orders/:id/cancel`.
- Paid, not shipped: `POST /refunds` with `physicalReturnRequired: false`.
- Delivered: `POST /refunds` (return needed).

**Received it**
Tap the NFC tag to claim it. A shipped order flips to `DELIVERED` and `unit.claimed` becomes `true`.

---

## 11. Errors (all buyer order endpoints)

| Status | Code | Endpoint | When |
|---|---|---|---|
| `404` | `ORDERS_NOT_FOUND` / `PAYMENTS_NOT_FOUND` | all | Not your order, or doesn't exist |
| `400` | `ORDERS_CANCEL_REQUIRES_REFUND` | cancel | Order is paid. Request a refund |
| `409` | `ORDERS_INVALID_TRANSITION` | cancel | Payment landed at the same moment |
| `409` | `PAYMENTS_RESERVATION_EXPIRED` | resume | Payment time ran out |
| `409` | `PAYMENTS_ORDER_NOT_PAYABLE` | resume | Already paid or cancelled |
| `400` | `PAYMENTS_GATEWAY_*` | resume | Stripe refused or was unreachable ([finance/stripe-adapter.md](../finance/stripe-adapter.md)) |
| `422` | `VALIDATION_ERROR` | all | Bad query or body (e.g. `limit` > 50) |

---

## 12. Where the code lives

```
packages/orders/src/
  dto/buyer-order.dto.ts               ← tabs, labels, response shapes
  repository/buyer-order.repository.ts ← buyer-keyed list / counts / detail queries
  service/buyer-order.service.ts       ← list, detail (+ actions), cancel unpaid
  controller/buyer-order.controller.ts
  service/order-shipment.service.ts    ← GET …/tracking
  domain/interfaces/media-url-resolver.interface.ts ← product image URLs
  module.ts                            ← createBuyerRouter → /orders
packages/payments/src/
  service/checkout.service.ts          ← resume()
  domain/payment-access.ts             ← buyer → OWN access (POST /refunds fix)
packages/orders/tests/buyer-orders.test.ts
packages/payments/tests/checkout-resume.test.ts, payment-access.test.ts
```
