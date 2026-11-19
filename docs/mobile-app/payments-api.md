# Payments — API

Buying a drop and getting money back. This API feeds the **Buy Now → Checkout**
sheet, the Stripe payment sheet, the **Complete payment** button on an unpaid
order, and the **Request a refund / Return item** flow on the order screen.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/checkout` | Bearer | Place an order: hold one piece for 15 min and start a Stripe payment |
| POST | `/checkout/:orderId/resume` | Bearer | Back to paying for an unpaid order (same order, same charge) |
| POST | `/refunds/evidence/upload-url` | Bearer | Upload URL for one photo of an item being returned |
| POST | `/refunds` | Bearer | Request a refund (also how to cancel a **paid** order) |
| GET | `/refunds/:refundId` | Bearer | One of my refunds, with its photos |

These paths sit directly under `/api/v1` (the router is mounted at `/`), so the
full path is `/api/v1/checkout`, `/api/v1/refunds`, and so on. Code:
`packages/payments` (`PaymentsController`, `CheckoutService`, `RefundService`,
`dto/payments.dto.ts`).

Start with the **Purchase flow** in [orders-api.md](orders-api.md#purchase-flow).
Payment status is read from the order: `GET /orders/:orderId` → `status` and
`payment` ([orders-api.md](orders-api.md)). There is no buyer endpoint for
payment transactions.

Stripe webhooks (`POST /webhooks/payments/stripe`, outside `/api/v1`) are
server-to-server. The app never calls them.

---

## Authentication

Every endpoint needs a signed-in user: the Clerk session JWT as
`Authorization: Bearer <token>`. See [auth-api.md](auth-api.md).

Checkout and resume also need `order:create`, which every buyer holds at `own`
scope. The refund routes need no extra grant: the server checks that the order
is the caller's. Someone else's order is a `404` on resume and a
`403 PAYMENTS_FORBIDDEN` on the refund routes; someone else's refund is a `404`.

---

## Shapes

Money is always a **decimal string** with up to 2 decimals (`"2499.00"`).

### `CheckoutView`: the result of checkout and resume

```jsonc
{
  "orderId": "8c1e2f6a-4b1d-4c55-9a3e-1f2b3c4d5e6f",  // → GET /orders/:orderId
  "paymentTransactionId": "f1a0c2d3-…",
  "skuId": "0b7e…",                     // the held piece (its number is not promised until packing)
  "reservationId": "a3c9…",
  "reservationExpiresAt": "2026-11-18T10:15:00.000Z", // pay before this; drives the countdown
  "amount": "2499.00",
  "currency": "INR",                    // USD | INR | GBP — the market's currency
  "gateway": "STRIPE",
  "status": "PENDING",                  // payment attempt: INITIATED (no Stripe adapter) | PENDING
  "clientToken": "pi_3Q…_secret_…",     // Stripe PaymentIntent client secret; null without the adapter
  "gatewayRef": "pi_3Q…"                // Stripe PaymentIntent id; null without the adapter
}
```

### `RefundView`: one refund request

```jsonc
{
  "id": "4b2d9f10-…",
  "orderId": "8c1e2f6a-…",
  "requestedById": "u_7f3e…",           // the buyer's own user id
  "reason": "The print is peeling after the first wash.",
  "reasonCode": "DEFECTIVE_ITEM",
  "status": "AWAITING_RETURN",          // REQUESTED | AWAITING_RETURN | APPROVED | PROCESSED | REJECTED
  "amount": "2499.00",
  "currency": "INR",
  "physicalReturnRequired": true,
  "physicalReturnConfirmedAt": null,    // when the warehouse received the item
  "nfcTagCondition": null,              // set by the warehouse on inspection
  "approvedById": null,
  "approvedAt": null,
  "rejectionReason": null,
  "gatewayRefundId": null,              // Stripe refund id once processed
  "gatewayStatus": null,                // PENDING | SUCCEEDED | FAILED | CANCELED; null until Stripe reports
  "gatewayFailureReason": null,
  "gatewayStatusAt": null,
  "processedAt": null,                  // when HitBox sent the money back
  "claimRevokedAt": null,
  "resaleBlockedUntil": null,
  "createdAt": "2026-10-25T08:00:00.000Z",
  "evidenceCount": 2,
  "evidence": [ RefundEvidence, … ],    // on this API always an array (detail responses)
  "allowedTransitions": ["APPROVED", "REJECTED"], // workflow info; not buyer actions
  "allowedActions": []                  // always [] for a buyer — staff buttons only
}
```

`gatewayStatus` of `FAILED` or `CANCELED` on a `PROCESSED` refund means the
buyer did **not** get the money. Show it clearly; HitBox support will follow up.

### `RefundEvidence`: one photo on a return

```jsonc
{
  "assetId": "a91f…",
  "position": 0,                        // display order
  "fileName": "IMG_0412.jpg",           // null when storage is not configured
  "mimeType": "image/jpeg",
  "sizeBytes": 2483120,
  "url": "https://…s3…?X-Amz-Signature=…", // signed GET; null → show a placeholder
  "expiresIn": 300,                     // seconds the url is valid
  "attachedAt": "2026-10-25T08:00:00.000Z"
}
```

### `ReturnEvidenceUploadView`: where to PUT one photo

```jsonc
{
  "assetId": "a91f…",                   // send this in POST /refunds → evidenceAssetIds
  "uploadUrl": "https://…s3…?X-Amz-Signature=…",
  "expiresIn": 300,                     // seconds (5 min)
  "requiredHeaders": { "Content-Type": "image/jpeg" } // send exactly these headers on the PUT
}
```

---

## Endpoints

### `POST /api/v1/checkout`

Places the order and starts the payment, in one call.

| Field | Rules | Default |
|---|---|---|
| `productId` | uuid, required | — |
| `variantId` | uuid | none (drop without variants) |
| `marketId` | uuid | none: the newest active price in any market |
| `quantity` | int, **must be 1** | `1` |
| `termsAccepted` | must be the literal `true` | required |
| `shippingAddressId` | uuid of one of the buyer's saved addresses | none |
| `billingAddressId` | uuid of one of the buyer's saved addresses | none |
| `gateway` | `STRIPE` | `STRIPE` |

```json
{
  "productId": "5d0b9e1c-2a4f-4b8e-9c1d-7e6f5a4b3c2d",
  "variantId": "c3a1e8f0-5b2d-4c7a-8e9f-0a1b2c3d4e5f",
  "termsAccepted": true,
  "shippingAddressId": "2f6d7c8b-…",
  "billingAddressId": "2f6d7c8b-…"
}
```

- An address id that is not the buyer's own is **silently ignored** (the order
  gets no address). Send a real one: the billing country decides the tax on
  the invoice.
- Send a `marketId` when the drop is priced in more than one market, so the
  buyer pays in the right currency.

**`201 Created`:**

```jsonc
{ "data": CheckoutView }
```

**Retrying is safe.** If the buyer already has an **unpaid order for the same
drop (and variant) whose hold has not expired**, `POST /checkout` returns that
order instead of placing a new one. This works exactly like
`POST /checkout/:orderId/resume`: same order, same held unit, same charge. So
if the response is lost (timeout, app killed, double tap), just send the same
request again. The server derives the Stripe idempotency key from the order
(`order:<orderId>:attempt:1`), so this never creates a second charge.

A new order is placed only when there is no such open order, for example
because the hold expired or the previous order was paid or cancelled.

| Status | Code | When |
|---|---|---|
| 404 | `ORDERS_NOT_FOUND` | No such drop, or it is switched off / archived |
| 400 | `ORDERS_NOT_PURCHASABLE` | Drop not on sale (status not `PUBLISHED`/`ACTIVE`), not open yet, or closed. `details` has `status`, `releaseStart` or `releaseEnd` |
| 409 | `ORDERS_OUT_OF_STOCK` | Every piece is sold or held by another checkout. Show "Sold out — check back" |
| 400 | `ORDERS_NO_PRICE` | No active price for the buyer's market |
| 400 | `PAYMENTS_NO_GATEWAY` | No active Stripe configuration for this drop |
| 400 | `PAYMENTS_GATEWAY_REJECTED` | Stripe refused to create the payment |
| 400 | `PAYMENTS_GATEWAY_UNREACHABLE` | Stripe could not be reached. Safe to retry via resume |
| 400 | `PAYMENTS_GATEWAY_UNAVAILABLE` | No Stripe adapter on this server |
| 422 | `VALIDATION_ERROR` | Bad body, e.g. `termsAccepted` not `true` or `quantity: 2` |
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |

The stock and price errors carry the `ORDERS_` prefix because the orders module
creates the order.

### Paying with Stripe

1. Initialise the Stripe SDK with the publishable key for the environment
   (`pk_test_…` in development, from app config; the API does not serve it).
2. Present the PaymentSheet with `clientToken` (a PaymentIntent client secret).
   The PaymentIntent has automatic payment methods enabled.
3. When the sheet reports **success**, show "Confirming payment…" and poll
   `GET /orders/:orderId` every 2–3 s until `status` is `PAID` (or
   `CANCELLED`). The webhook usually lands within seconds.
4. When the sheet is **dismissed**, the order stays `PENDING_PAYMENT`. Show
   **Complete payment** while `actions.canResumePayment` is true.
5. When the card is **declined**, Stripe's `payment_intent.payment_failed`
   webhook **cancels the order** and releases the piece. Start a new checkout.

If `clientToken` is `null`, this server has no Stripe adapter and cannot take
payments in-app.

### `POST /api/v1/checkout/:orderId/resume`

No body. For an order that is `PENDING_PAYMENT` and whose hold is still live
(`actions.canResumePayment` on the order detail).

Returns the **same order, held piece and payment attempt**, with a fresh
`clientToken` for the same PaymentIntent:

```jsonc
{ "data": CheckoutView }   // 200
```

| Status | Code | When |
|---|---|---|
| 404 | `PAYMENTS_NOT_FOUND` | No such order, or not yours |
| 409 | `PAYMENTS_ORDER_NOT_PAYABLE` | Already paid, cancelled, or no open payment attempt. `details.status` when known. Reload the order |
| 409 | `PAYMENTS_RESERVATION_EXPIRED` | Time ran out and the piece was released. "Time ran out — start again" → new checkout |
| 400 | `PAYMENTS_NO_GATEWAY`, `PAYMENTS_GATEWAY_*` | As for checkout |

### `POST /api/v1/refunds/evidence/upload-url`

Step 1 of a **return**: get an upload URL for **one** photo. Call it once per
photo (1–8 photos).

| Field | Rules |
|---|---|
| `orderId` | uuid, required |
| `fileName` | string, 1–255 chars |
| `mimeType` | `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` |
| `sizeBytes` | positive int, the exact file size; max 15 MB |

```json
{ "orderId": "8c1e2f6a-…", "fileName": "IMG_0412.jpg", "mimeType": "image/jpeg", "sizeBytes": 2483120 }
```

```jsonc
{ "data": ReturnEvidenceUploadView }   // 201
```

Then `PUT` the raw file bytes to `uploadUrl` with exactly `requiredHeaders`. The
size is part of the signature, so a different length is rejected by S3.

The refund eligibility checks run here too, so the buyer learns "this order
can't be returned" **before** taking photos. Errors are the same as
`POST /refunds` (below), plus media's own errors for a wrong MIME type or size.

### `POST /api/v1/refunds`

Request a refund on your own order. This is also how to **cancel a paid order**.

| Field | Rules | Default |
|---|---|---|
| `orderId` | uuid, required | — |
| `reasonCode` | `DEFECTIVE_ITEM` `DEFECTIVE_TAG` `NOT_AS_DESCRIBED` `NOT_DELIVERED` `DUPLICATE_CHARGE` `BUYER_CHANGED_MIND` `FRAUDULENT_CHARGE` `OTHER` | required |
| `reason` | string, trimmed, 1–1000 chars. **At least 20 chars on a return** | required |
| `amount` | decimal string, ≤ 2 decimals (`"1200.00"`) | the full order amount |
| `physicalReturnRequired` | boolean | **`true`** |
| `evidenceAssetIds` | uuid array, max 8, no duplicates. **At least 1 on a return** | `[]` |

A **return** means `physicalReturnRequired: true` (the default). Send
**`false`** when the order has not shipped (`PAID` / `PROCESSING`): that is the
"cancel and refund" case, and no photos are needed.

Return (delivered item):

```json
{
  "orderId": "8c1e2f6a-…",
  "reasonCode": "DEFECTIVE_ITEM",
  "reason": "The print is peeling after the first wash.",
  "physicalReturnRequired": true,
  "evidenceAssetIds": ["a91f…", "b20c…"]
}
```

Cancel a paid order that has not shipped:

```json
{
  "orderId": "8c1e2f6a-…",
  "reasonCode": "BUYER_CHANGED_MIND",
  "reason": "Ordered the wrong size",
  "physicalReturnRequired": false
}
```

```jsonc
{ "data": RefundView }   // 201; evidence[] has the photos with signed URLs
```

Use `actions.canRequestRefund` on the order detail to decide whether to show the
button. After this, follow the refund in `refunds[]` on `GET /orders/:orderId`.

| Status | Code | When |
|---|---|---|
| 404 | `PAYMENTS_NOT_FOUND` | No such order |
| 403 | `PAYMENTS_FORBIDDEN` | The order is someone else's |
| 400 | `PAYMENTS_NOT_REFUNDABLE` | Order is not `PAID`, `PROCESSING`, `SHIPPED` or `DELIVERED`. `details.status` |
| 409 | `PAYMENTS_INVALID_TRANSITION` | A refund is already open. `details.refundRequestId`, `details.status` |
| 400 | `PAYMENTS_RETURN_WINDOW_CLOSED` | More than 10 days since delivery. `details`: `deliveredAt`, `returnWindowEndsAt`, `returnWindowDays` |
| 400 | `PAYMENTS_AMOUNT_EXCEEDS_CAPTURE` | Amount + earlier refunds > order amount. `details`: `orderAmount`, `alreadyRefunded`, `requested` |
| 400 | `PAYMENTS_RETURN_DESCRIPTION_TOO_SHORT` | Return with `reason` under 20 chars. `details`: `minLength`, `length` |
| 400 | `PAYMENTS_RETURN_EVIDENCE_REQUIRED` | Return with no photos |
| 400 | `PAYMENTS_RETURN_EVIDENCE_INVALID` | A photo can't be used. `details.problems[]`: `{ assetId, problem }` with `NOT_FOUND`, `WRONG_ORDER`, `ARCHIVED`, `REJECTED_BY_SCAN`, `NOT_UPLOADED`, `ALREADY_ATTACHED`. Re-upload those and resend |
| 409 | `PAYMENTS_RETURN_EVIDENCE_INVALID` | A photo was attached to another return at the same moment |
| 400 | `PAYMENTS_EVIDENCE_STORAGE_UNAVAILABLE` | Photo storage not configured on this server; returns can't be placed |
| 422 | `VALIDATION_ERROR` | Bad body |

### `GET /api/v1/refunds/:refundId`

One of my refunds, with its photos (signed URLs valid for 5 minutes; fetch
again to refresh them).

```jsonc
{ "data": RefundView }
```

| Status | Code | When |
|---|---|---|
| 404 | `PAYMENTS_NOT_FOUND` | No such refund, or not on one of your orders |

---

## How it works

### Checkout, step by step

1. **Order + hold** (one database transaction). The server checks the drop is
   on sale and finds its current price for the market. It picks the
   lowest-numbered free piece and creates the order (`PENDING_PAYMENT`). It holds
   the piece for 15 minutes and copies the chosen addresses onto the order.
   Two buyers racing for the last piece: exactly one wins, the other gets
   `409 ORDERS_OUT_OF_STOCK`.
2. **Gateway config.** The Stripe configuration for the drop's organization (or
   the platform default) is chosen. None → `PAYMENTS_NO_GATEWAY`.
3. **Payment attempt.** A payment transaction is created with the idempotency
   key `order:<orderId>:attempt:1`.
4. **Stripe.** A PaymentIntent is created; status becomes `PENDING` and the
   client secret is returned as `clientToken`.
5. **Settlement (webhook).** Stripe's `payment_intent.succeeded` marks the
   payment `SUCCEEDED`, the order `PAID` and the hold `COMMITTED`.

### Payment attempt statuses

These are internal; the app reads `payment.status` on the order instead.

```
INITIATED ──▶ PENDING ──(webhook: succeeded)──▶ SUCCEEDED
                  │
                  └────(webhook: failed)──────▶ FAILED   (order CANCELLED, piece released)
```

A payment that succeeds after its piece went to someone else is marked
`SUCCEEDED` but parked for staff review (`needsReview`). The order is not
marked paid, and staff refund the buyer.

### Refund rules

A buyer may request a refund when **all** are true (this is what
`actions.canRequestRefund` checks):

| Rule | Otherwise |
|---|---|
| Order is `PAID`, `PROCESSING`, `SHIPPED` or `DELIVERED` | `ORDER_NOT_REFUNDABLE` |
| No refund is open (`REQUESTED`, `AWAITING_RETURN`, `APPROVED`) | `REFUND_IN_PROGRESS` |
| Delivered less than 10 days ago, or not delivered yet | `RETURN_WINDOW_CLOSED` |
| Something is left to refund (order amount − processed refunds > 0) | `FULLY_REFUNDED` |

On a return (`physicalReturnRequired: true`) the buyer must also give a
description of 20+ characters and 1–8 photos.

### Refund statuses

```
              ┌─ physicalReturnRequired: true ─▶ AWAITING_RETURN ─┐
POST /refunds ┤                                                   ├─▶ APPROVED ─▶ PROCESSED
              └─ physicalReturnRequired: false ─▶ REQUESTED ──────┘       │
                                                                          │
                        any open status ─────────────────────────────────┴──▶ REJECTED
```

1. **Requested.** A return starts at `AWAITING_RETURN`; a refund with nothing
   to send back starts at `REQUESTED`.
2. **Item received.** For a return, the warehouse confirms it arrived and notes
   the NFC tag's condition. **Money never moves before the item is back.**
3. **Approved** by HitBox staff (manual).
4. **Processed.** The refund is sent through Stripe. The order becomes
   `REFUNDED`. If the buyer had already claimed the item, ownership is revoked.
   A piece that never shipped, or came back intact, goes back on sale. A
   damaged, missing or tampered tag blocks resale for 90 days.
5. **Rejected** at any open step, with `rejectionReason`.

After `PROCESSED`, the bank usually takes 5–10 business days. Stripe's later
report shows in `gatewayStatus`.

Steps 2–5 are staff actions, not available to the app. See
[../orders/order-payments-and-refunds-api.md](../orders/order-payments-and-refunds-api.md)
for the operator side.

---

## Known limitations

- **Checkout de-duplicates by drop, not by request key.** While an unpaid
  order with a live hold exists for a drop, every `POST /checkout` for that
  drop returns it, even if the buyer deliberately wanted a second one.
  Quantity is capped at 1 per order anyway. Rare edge case: if the server
  failed between placing the order and creating its payment attempt, the
  retry gets 409 `PAYMENTS_ORDER_NOT_PAYABLE` until the hold expires.
- **A declined card cancels the order.** Stripe's `payment_failed` webhook
  cancels the order and releases the piece, so "try another card" needs a new
  checkout. `payment.failureReason` on a `CANCELLED` order explains why.
- **Resume does not extend the hold.** `reservationExpiresAt` stays the
  original time.
- **One item per order** (`quantity` must be 1). No cart.
- **Stripe only.** `gateway` accepts only `STRIPE`.
- **The publishable key is not served by the API.** Ship it in app config.
- **No buyer cancel for an open refund.** Once requested, only staff can
  move it on.
