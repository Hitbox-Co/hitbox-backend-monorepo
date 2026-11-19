# Cart — API

The **Add to cart** button and the **Cart** screen.

> **Database migration required.** The cart uses a new table, `CartItem`
> (migration `20261118120000_cart_item`). Until it is applied
> (`pnpm db:migrate`), every `/cart` call fails with 500. Nothing else depends on it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/cart` | required | The cart: each item with live price and availability, plus a summary |
| POST | `/cart` | required | Add a drop (and variant). Idempotent. |
| DELETE | `/cart/:itemId` | required | Remove one item |
| DELETE | `/cart` | required | Empty the cart |

Base path: `/api/v1/cart`. Code: `packages/orders` (routes, service, `CartItem`
table) and `packages/products/src/domain/drop-card-lookup.adapter.ts` (the cards
and availability).

---

## What the cart is, and is not

- **A list of drops the buyer means to buy.** One row per drop (and variant).
- **Not a reservation.** Adding to the cart holds no stock. Someone else can buy the
  last unit while it sits in the cart. Stock is only held at checkout, for 15 minutes.
- **No stored price.** Price and availability are read **live** every time the cart
  is shown, so they are never stale.
- **Checked out one item at a time.** An order is exactly one serialized unit, so
  each cart item is paid for with its own `POST /checkout` (see the flow below).
- **No quantity.** One row = one unit, because checkout's `quantity` is capped at 1.

---

## Authentication

Every route needs the Clerk session: `Authorization: Bearer <token>`. A buyer
only ever sees and changes their own cart. Another user's item id is a 404. See
[auth-api.md](auth-api.md).

---

## Shapes

### `CartView`

```jsonc
{
  "items": [ CartItemView, … ],          // newest first
  "summary": {
    "itemCount": 3,                      // all rows
    "purchasableCount": 2,               // rows checkout would accept right now
    "subtotals": [                       // purchasable rows only, one entry per currency
      { "currency": "USD", "amount": "335.00" }
    ]
  }
}
```

`subtotals` is **indicative**. Each item is charged separately at checkout, at the
price for the buyer's market and variant. The cart shows the drop's base price in
the default market.

### `CartItemView`

```jsonc
{
  "id": "c3d4…",                         // CartItem id: use it for DELETE /cart/:itemId
  "productId": "6f1c…",                  // Drop id: send it to POST /checkout
  "variant": { "id": "9a2d…", "label": "Size M" },  // null = no variant chosen
  "addedAt": "2026-11-18T10:00:00.000Z",
  "product": CartDropCard                // null only if the drop row is gone
}
```

### `CartDropCard`

This is the same card as Discover and Marketplace, plus state. It is identical to
the wishlist's card ([wishlist-api.md](wishlist-api.md#wishlistdropcard)):

```jsonc
{
  "id": "6f1c…", "name": "Cobalt Mind", "imageUrl": "https://…", "rarity": "RARE",
  "artist": { "id": "…", "name": "Form & Co.", "slug": "form-co" },
  "price": { "amount": "225.00", "currency": "USD", "isFree": false },
  "totalSupply": 60, "mintedCount": 9, "rewardPoints": 1125,
  "status": "ACTIVE",
  "isViewable": true,
  "isPurchasable": true,                 // false → disable "Checkout" for this row
  "unavailableReason": null,             // REMOVED | NOT_ON_SALE | NOT_RELEASED_YET | CLOSED | NO_PRICE
  "variants": [ { "id": "9a2d…", "label": "Size M", "isActive": true } ]
}
```

The meaning and suggested label for each `unavailableReason` are in
[wishlist-api.md](wishlist-api.md#wishlistdropcard).

---

## Endpoints

### `GET /api/v1/cart`

There are no parameters. The cart holds at most 50 items, so it is never paginated.

```jsonc
{ "data": CartView }
```

### `POST /api/v1/cart`: add to cart

```json
{ "productId": "6f1c…", "variantId": "9a2d…" }
```

| Field | Rule |
|---|---|
| `productId` | required, uuid |
| `variantId` | optional, uuid. Must be one of the drop's variants that is **active** and not archived. |
| anything else | rejected (422) |

The drop must be one `POST /checkout` would accept **right now**: status
`PUBLISHED` or `ACTIVE`, switched on, not archived, inside its release window, and
with a price. Stock is not checked here.

Response: **201** `{ "data": CartItemView }` when added, **200** with the existing
row when that drop (and variant) was already in the cart.

### `DELETE /api/v1/cart/:itemId`

Removes one item. Response: **204** with no body.

### `DELETE /api/v1/cart`

Empties the cart. Response: `{ "data": { "removed": 3 } }`. This is always 200,
even when the cart was already empty.

### Errors

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_…` | No or bad session ([README.md](README.md#authentication)) |
| 400 | `ORDERS_NOT_PURCHASABLE` | `POST`: the drop is not on sale now. `details: { status, reason }`, where `reason` is an `unavailableReason`. |
| 400 | `ORDERS_NO_PRICE` | `POST`: the drop has no price for the default market |
| 404 | `ORDERS_NOT_FOUND` | `POST`: no such drop, or it is not viewable |
| 404 | `ORDERS_VARIANT_NOT_FOUND` | `POST`: the variant is not one of this drop's, or is switched off |
| 404 | `ORDERS_CART_ITEM_NOT_FOUND` | `DELETE /:itemId`: no such item **of yours** |
| 409 | `ORDERS_CART_FULL` | `POST`: the cart already has 50 items. `details: { max: 50 }` |
| 422 | `VALIDATION_ERROR` | Not a uuid, unknown field |

The codes start with `ORDERS_` because the cart lives in the orders module, and
they are the same codes checkout uses for the same problems.

---

## How it works

### Add to cart → pay, end to end

```text
1. Product screen       POST /cart { productId, variantId? }            → 201 (or 200 if already there)
2. Cart screen          GET /cart                                       → items + summary
3. "Checkout" on a row  POST /checkout { productId, variantId?, termsAccepted: true, gateway }
                        → order + Stripe client token (payments-api.md)
4. Pay in the Stripe SDK
5. Stripe webhook       order → PAID, and in the SAME transaction the cart row
                        for that drop/variant is deleted
6. Back on the cart     GET /cart                                       → the paid item is gone
```

Checkout itself is unchanged and documented in [payments-api.md](payments-api.md).
The cart only remembers what to check out.

To check out several items, repeat step 3 for each row. Every row is its own order,
its own payment and its own invoice. Retrying `POST /checkout` for a row that
already has an unpaid order resumes that order instead of creating a second one.

### When a cart row is removed

| Event | Row |
|---|---|
| The order for that drop **and** variant is paid | deleted automatically |
| Checkout started but not paid, card declined, or hold expired | **kept**, so the buyer can try again |
| The drop ends, is switched off, or loses its price | **kept**, shown with `isPurchasable: false` |
| `DELETE /cart/:itemId` or `DELETE /cart` | deleted |

### One row per drop and variant

A row is unique per (buyer, drop, variant), and this is enforced in the database,
including for "no variant". Adding the same drop twice returns the existing row.
Different variants of one drop are separate rows.

---

## Known limitations

- **No stock check.** The cart can show an item as purchasable while every unit is
  sold or held. Checkout then returns `ORDERS_OUT_OF_STOCK`.
- **No single "pay for everything".** One order per item is how orders work today.
  Paying for the whole cart in one go needs multi-item orders across orders,
  payments, refunds, invoices and finance.
- **The subtotal ignores variant prices and the buyer's market.** It sums the base
  price in the default market. Checkout charges the right price.
- **A row added with no variant is not removed by paying for a variant of that
  drop**, and vice versa. The match is exact.
