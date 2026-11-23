# Payments — API

Buying a drop and getting money back. This API feeds the **Buy Now → Checkout**
sheet, the Stripe payment sheet, the **Complete payment** button on an unpaid
order, and the **Request a refund / Return item** flow on the order screen.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/markets` | none | The markets (currencies) a buyer can shop in, to pick a `marketId` |
| POST | `/checkout/quote` | Bearer | The price breakdown to show before paying. No hold, no Stripe call |
| POST | `/checkout` | Bearer | Place an order: hold one piece for 15 min and start a Stripe payment |
| POST | `/checkout/:orderId/resume` | Bearer | Back to paying for an unpaid order (same order, same charge) |
| POST | `/refunds/evidence/upload-url` | Bearer | Upload URL for one photo of an item being returned |
| POST | `/refunds` | Bearer | Request a refund (also how to cancel a **paid** order) |
| GET | `/refunds/:refundId` | Bearer | One of my refunds, with its photos |

These paths sit directly under `/api/v1` (the router is mounted at `/`), so the
full path is `/api/v1/checkout`, `/api/v1/refunds`, and so on. Code:
`packages/payments` (`PaymentsController`, `CheckoutService`, `RefundService`,
`dto/payments.dto.ts`).

`GET /markets` is mounted at `/api/v1/markets` and is public (markets module).
The buyer's saved addresses that checkout takes are in
[addresses-api.md](addresses-api.md).

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

### `CheckoutQuote`: the price before paying

All money and rates are **strings**. Prices are **tax-inclusive**: `unitPrice` is
the sticker price and already contains the tax, so
`totalAmount = subtotal + taxAmount + shippingAmount` and, today, equals
`unitPrice` (see [How the charge relates to the invoice](#how-the-charge-relates-to-the-invoice)).

```jsonc
{
  "productId": "5d0b9e1c-2a4f-4b8e-9c1d-7e6f5a4b3c2d",
  "variantId": "c3a1e8f0-5b2d-4c7a-8e9f-0a1b2c3d4e5f",  // null for a drop without variants
  "marketId": "0e5f…",                  // the market the price belongs to; send it back to /checkout
  "currency": "INR",                    // USD | INR | GBP: the market's currency
  "unitPrice": "2499.00",               // the sticker price, tax included
  "subtotal": "2231.25",                // the price without tax
  "taxType": "GST",                     // GST | SALES_TAX | EXEMPT | null (no rate configured)
  "taxRate": "12.000",                  // percent
  "taxAmount": "267.75",                // the part of the price that is tax
  "shippingAmount": "0.00",             // HitBox charges no shipping today
  "totalAmount": "2499.00",             // exactly what the card is charged
  "availability": "IN_STOCK",           // IN_STOCK | SOLD_OUT | NOT_ON_SALE
  "unavailableReason": null,            // NOT_PUBLISHED | NOT_OPEN_YET | CLOSED | SOLD_OUT; null when IN_STOCK
  "billingAddressRequired": false       // true: POST /checkout will refuse without a billing address
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

### `GET /api/v1/markets`

Public (no token). The active markets, so the app can pass the right `marketId`
to the quote and to checkout. The **default market comes first**, then the rest
by code. Cached for 5 minutes (`Cache-Control: public, max-age=300`).
Rate limit: 60 requests a minute per IP.

```json
{
  "data": [
    { "id": "0e5f7a1c-3b2d-4e8f-9a0b-1c2d3e4f5a6b", "currency": "USD", "countryCodes": ["US", "CA"] },
    { "id": "7c1d9e2f-6a3b-4c5d-8e9f-0a1b2c3d4e5f", "currency": "INR", "countryCodes": ["IN"] },
    { "id": "b2e4f6a8-1c3d-4e5f-9a7b-8c9d0e1f2a3b", "currency": "GBP", "countryCodes": ["GB"] }
  ]
}
```

Pick the market whose `countryCodes` contains the buyer's country (their
default address's `countryCode`, or the device region), and fall back to the
first item. Inactive and archived markets are never listed. The operator
version, with usage counts, is `GET /admin/markets`.

### `POST /api/v1/checkout/quote`

What the buyer will pay, **before** paying. It has no side effects: no order, no
stock hold, no Stripe call. Call it when the Buy Now sheet opens and again when
the buyer changes variant, address or market.

| Field | Rules |
|---|---|
| `productId` | uuid, required |
| `variantId` | uuid |
| `marketId` | uuid. None: the newest active price in any market (as for checkout) |
| `shippingAddressId` | uuid of one of the buyer's saved addresses |
| `billingAddressId` | uuid of one of the buyer's saved addresses. Its country (and, for the US, state) picks the tax |

```json
{
  "productId": "5d0b9e1c-2a4f-4b8e-9c1d-7e6f5a4b3c2d",
  "variantId": "c3a1e8f0-5b2d-4c7a-8e9f-0a1b2c3d4e5f",
  "marketId": "7c1d9e2f-6a3b-4c5d-8e9f-0a1b2c3d4e5f",
  "billingAddressId": "2f6d7c8b-4a1e-4b9c-8d3f-5e6a7b8c9d0e"
}
```

**`200 OK`**:

```json
{
  "data": {
    "productId": "5d0b9e1c-2a4f-4b8e-9c1d-7e6f5a4b3c2d",
    "variantId": "c3a1e8f0-5b2d-4c7a-8e9f-0a1b2c3d4e5f",
    "marketId": "7c1d9e2f-6a3b-4c5d-8e9f-0a1b2c3d4e5f",
    "currency": "INR",
    "unitPrice": "2499.00",
    "subtotal": "2231.25",
    "taxType": "GST",
    "taxRate": "12.000",
    "taxAmount": "267.75",
    "shippingAmount": "0.00",
    "totalAmount": "2499.00",
    "availability": "IN_STOCK",
    "unavailableReason": null,
    "billingAddressRequired": false
  }
}
```

Sold out is an **answer**, not an error, so the screen can show the price next to
"Sold out":

```json
{
  "data": {
    "productId": "5d0b9e1c-2a4f-4b8e-9c1d-7e6f5a4b3c2d",
    "variantId": null,
    "marketId": "7c1d9e2f-6a3b-4c5d-8e9f-0a1b2c3d4e5f",
    "currency": "INR",
    "unitPrice": "2499.00",
    "subtotal": "2231.25",
    "taxType": "GST",
    "taxRate": "12.000",
    "taxAmount": "267.75",
    "shippingAmount": "0.00",
    "totalAmount": "2499.00",
    "availability": "SOLD_OUT",
    "unavailableReason": "SOLD_OUT",
    "billingAddressRequired": true
  }
}
```

How to read it:

- **Show `totalAmount` as the price to pay.** The card is charged exactly that
  (`POST /checkout` returns the same figure as `amount`). Show `taxAmount` as
  "includes ₹267.75 GST" if you want a breakdown.
- **With no `billingAddressId`**, the tax is estimated for the market's home
  country (`INR` → India, any other currency → US) and `billingAddressRequired`
  tells you whether checkout will insist on one. Re-quote once the buyer picks a
  billing address: the tax country and state come from it.
- `availability`: `IN_STOCK` (a piece is free right now: not a promise, another
  buyer can still take it), `SOLD_OUT` (every piece is sold or held),
  `NOT_ON_SALE` (`unavailableReason` says why: `NOT_PUBLISHED`, `NOT_OPEN_YET`,
  `CLOSED`). Disable **Buy** unless it is `IN_STOCK`.
- `taxType` is `null` with `taxRate` `"0.000"` when no tax rate is configured for
  the buyer's country. That is a setup gap on HitBox's side, not something the
  buyer can fix.

| Status | Code | When |
|---|---|---|
| 404 | `ORDERS_NOT_FOUND` | No such drop, or it is switched off / archived |
| 400 | `ORDERS_NO_PRICE` | No active price for the buyer's market (or the drop needs a `variantId`) |
| 400 | `USERS_ADDRESS_ARCHIVED` | One of the address ids is the buyer's but was deleted |
| 400 | `USERS_ADDRESS_USAGE_MISMATCH` | A shipping-only address sent as billing, or the reverse |
| 422 | `VALIDATION_ERROR` | Bad body (not a uuid, …) |
| 400 | `BODY_REQUIRED` | No JSON body |
| 429 | `RATE_LIMITED` | Over 60 quotes a minute per user |

An address id that is not the buyer's is **ignored**, exactly as in checkout.

Needs `order:create` like checkout (every buyer holds it at `own` scope), so
there is no new permission.

### `POST /api/v1/checkout`

Places the order and starts the payment, in one call.

| Field | Rules | Default |
|---|---|---|
| `productId` | uuid, required | — |
| `variantId` | uuid | none (drop without variants) |
| `marketId` | uuid | none: the newest active price in any market |
| `quantity` | int, **must be 1** | `1` |
| `termsAccepted` | must be the literal `true` | required |
| `shippingAddressId` | uuid of one of the buyer's saved addresses ([addresses-api.md](addresses-api.md)) | none |
| `billingAddressId` | uuid of one of the buyer's saved addresses. **Required on a taxed drop**, see [Billing address rule](#billing-address-rule) | none |
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
  gets no address), as before. An id that **is** the buyer's but was deleted
  (archived) is now **rejected** with `400 USERS_ADDRESS_ARCHIVED`. Both rules
  are one shared check, the same one the quote and
  [addresses-api.md](addresses-api.md#how-checkout-uses-addresses) use.
- Because an ignored id counts as "no address", a **taxed** drop sent with only
  a stranger's `billingAddressId` is refused as `PAYMENTS_BILLING_ADDRESS_REQUIRED`.
- Send a `marketId` when the drop is priced in more than one market, so the
  buyer pays in the right currency. `GET /markets` lists them.
- The amount charged is the quote's `totalAmount`. Quote first, then check out
  with the same `variantId`, `marketId` and addresses.

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
| 400 | `PAYMENTS_BILLING_ADDRESS_REQUIRED` | The sale is taxed and no usable billing address was sent. `details.currency`. Nothing was held. Ask for a billing address and retry |
| 400 | `USERS_ADDRESS_ARCHIVED` | `shippingAddressId` or `billingAddressId` is the buyer's but was deleted. `details`: `addressId`, `use` |
| 400 | `USERS_ADDRESS_USAGE_MISMATCH` | A shipping-only address sent as billing, or the reverse. `details`: `addressId`, `use`, `usage` |
| 400 | `PAYMENTS_NO_GATEWAY` | No active Stripe configuration for this drop |
| 400 | `PAYMENTS_GATEWAY_REJECTED` | Stripe refused to create the payment |
| 400 | `PAYMENTS_GATEWAY_UNREACHABLE` | Stripe could not be reached. Safe to retry via resume |
| 400 | `PAYMENTS_GATEWAY_UNAVAILABLE` | No Stripe adapter on this server |
| 422 | `VALIDATION_ERROR` | Bad body, e.g. `termsAccepted` not `true` or `quantity: 2` |
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |

The stock and price errors carry the `ORDERS_` prefix because the orders module
creates the order; the address errors carry `USERS_` because the users module
owns the address book.

### Billing address rule

**A taxed drop cannot be bought without a billing address.** `POST /checkout`
refuses with `400 PAYMENTS_BILLING_ADDRESS_REQUIRED` before anything is held.

Why this is enforced (not left to the currency fallback): the invoice is a legal
document and the billing country picks the tax rules and rate. Without one, the
server can only guess the country from the currency (`INR` → India, anything
else → US). That guess is right for a US buyer paying in `USD` and wrong for a
UK buyer paying in `GBP`, who would get a US invoice. A wrong invoice cannot be
edited later, only voided and re-issued. Asking for the address up front costs
the buyer one field; fixing a wrong invoice costs a support case.

When it fires: the buyer sent **no usable** `billingAddressId` (none, or not the
buyer's) **and** the sale would be taxed in the market's home country **and**
the price is above zero **and** a piece is available. In every other case
(free drop, no tax rate configured, sold out, closed) checkout behaves as
before and a sold-out or closed drop reports its own error, not this one.

Use `billingAddressRequired` on the [quote](#post-apiv1checkoutquote) to decide
up front whether to show the billing address picker as mandatory.

### How the charge relates to the invoice

**Prices are tax-inclusive. What the buyer is charged, what the quote shows as
`totalAmount`, and the invoice's `totalAmount` are the same number.**

| | Before | Now |
|---|---|---|
| Stripe charge | order price | order price (unchanged) |
| Invoice `totalAmount` | order price **+ tax** | order price |
| Invoice `subtotal` / `taxAmount` | price / tax added on top | price ÷ (1 + rate) / the rest of the price |

Example, ₹2,499.00 at 12% GST: subtotal ₹2,231.25 + tax ₹267.75 = **₹2,499.00**,
the amount charged and the amount on the invoice.

Why inclusive rather than charging price + tax:

1. **They cannot disagree.** The invoice total is the charge by construction;
   there is no second amount to keep in step.
2. **Nothing else moves.** Stripe, the webhook's amount check, refunds ("amount
   exceeds capture"), and finance's gross revenue all already read
   `order.amount`. Charging price + tax would need a new tax column on the order
   and changes in all four.
3. **It matches the prices already shown.** The app and catalogue show one
   sticker price per market, and in India (the main market) consumer prices are
   quoted tax-inclusive.

The quote uses the invoice's own arithmetic (the same rate lookup and the same
split function), so a quote and the invoice that follows it match.

**Trade-offs to know about:**

- In the **US**, sales tax is normally added at the till. With inclusive pricing
  a `$25.00` price is `$25.00` charged, and HitBox keeps `$25.00 − tax`. If you
  want US buyers to pay price + tax, that needs a per-market "tax is added on
  top" setting and `Order.taxAmount`; it is not built.
- Finance books `order.amount` as gross revenue, which includes the tax portion.
  That was already true before this change (the charge never included tax on top,
  so gross was always the charged amount); nothing is worse, but royalty is
  calculated on a figure that includes tax.
- Invoices issued **before** this change keep their old figures and have
  `pricesIncludeTax: false`.

### Paying with Stripe

1. Initialise the Stripe SDK with the publishable key for the environment
   (`pk_test_…` in development, from app config; the API does not serve it).
2. Present the PaymentSheet with `clientToken` (a PaymentIntent client secret).
   The PaymentIntent has automatic payment methods enabled, which is what puts
   **Apple Pay and Google Pay** in the sheet (see [Wallets](#wallets-apple-pay-and-google-pay)).
3. When the sheet reports **success**, show "Confirming payment…" and poll
   `GET /orders/:orderId` every 2–3 s until `status` is `PAID` (or
   `CANCELLED`). The webhook usually lands within seconds.
4. When the sheet is **dismissed**, the order stays `PENDING_PAYMENT`. Show
   **Complete payment** while `actions.canResumePayment` is true.
5. When the card is **declined**, Stripe's `payment_intent.payment_failed`
   webhook **cancels the order** and releases the piece. Start a new checkout.

If `clientToken` is `null`, this server has no Stripe adapter and cannot take
payments in-app.

### Wallets: Apple Pay and Google Pay

**There is no wallet endpoint and none is needed.** Apple Pay and Google Pay are
offered by Stripe's PaymentSheet, not by this API. The server creates every
PaymentIntent with `automatic_payment_methods[enabled]=true` and **does not pin
`payment_method_types`**, so the methods the sheet offers come from your Stripe
dashboard configuration. A test in `packages/payments/tests/stripe-gateway.test.ts`
guards this: adding `payment_method_types` to PaymentIntent creation would
silently turn wallets off.

What must be switched on (all in Stripe, nothing in this repo):

| Where | Setting |
|---|---|
| Dashboard → Settings → Payments → **Payment methods** | The active **payment method configuration** has **Apple Pay** and **Google Pay** turned **on** (they are on by default; check the configuration that applies, including any per-account override for an organization on its own Stripe account). |
| Dashboard → Settings → Payments → Payment methods → Apple Pay | **iOS app:** register the **Apple merchant ID** (create it in the Apple Developer account, then upload Stripe's CSR and add the certificate). **Web checkout** would also need the domain verified there; the mobile app does not. |
| Apple Developer account | A **Merchant ID** (`merchant.…`) and the **Apple Pay** capability on the app's identifier. |
| Dashboard → Google Pay | Nothing to register for Stripe-processed cards. Stripe is the gateway. **Production** Google Pay needs the app's Google Pay business profile approved by Google; **test** mode works with Stripe test keys. |
| Currencies | The wallet only shows when the wallet and the card networks support the PaymentIntent's currency (`USD`, `INR`, `GBP` are fine). The buyer's device also needs a card in the wallet. |

What the **app** must do:

- Configure PaymentSheet with `applePay: { merchantCountryCode, merchantIdentifier }`
  and `googlePay: { merchantCountryCode, currencyCode, testEnv }`. Use the
  quote's `currency` for `currencyCode`.
- Keep presenting the sheet with `clientToken` from `POST /checkout` or
  `/resume`; a wallet payment settles through the same `payment_intent.succeeded`
  webhook as a card, so nothing else changes.

Compatibility notes for the server side: the PaymentIntent must stay a plain
automatic-methods intent: no `payment_method_types`, no `payment_method`, no
`confirm`. `/resume` returns the same intent, so a wallet choice survives a
dismissed sheet.

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

0. **Addresses and billing rule.** The buyer's address ids go through the
   shared ownership check (stranger's ignored, archived rejected), and a taxed
   sale with no billing address is refused, before anything is held.
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
- **A quote is a snapshot.** It does not hold a piece or lock the price or tax
  rate. The charge is whatever the price is at checkout; re-quote if the sheet
  stays open for long.
- **No shipping charge.** `shippingAmount` is always `"0.00"` until shipping is
  priced.
- **US sales tax is inside the price** (see
  [How the charge relates to the invoice](#how-the-charge-relates-to-the-invoice)).
- **The billing rule depends on tax configuration.** If staff have not
  configured a tax rate for the market's home country, no billing address is
  demanded, `taxType` is `null`, and the invoice cannot be issued until a rate
  is added (`TAX_NO_CONFIGURATION`).
- **Stripe only.** `gateway` accepts only `STRIPE`.
- **The publishable key is not served by the API.** Ship it in app config.
- **No buyer cancel for an open refund.** Once requested, only staff can
  move it on.
