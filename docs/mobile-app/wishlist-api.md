# Wishlist — API

Saving drops for later: the **heart** on every card (Discover, Marketplace, product
detail) and the **Wishlist** screen that lists what was saved.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/wishlist` | required | The buyer's wishlist, newest first, paginated |
| POST | `/wishlist` | required | Save a drop (heart **on**). Idempotent. |
| DELETE | `/wishlist/products/:productId` | required | Unsave a drop by its id (heart **off**). Idempotent. |
| PATCH | `/wishlist/:itemId` | required | Change a saved row's alert or note |
| DELETE | `/wishlist/:itemId` | required | Remove one row from the Wishlist screen |

Base path: `/api/v1/wishlist`. Code: `packages/social` (routes, service; the
`WishlistItem` table is social's) and
`packages/products/src/domain/drop-card-lookup.adapter.ts` (the cards).

---

## Authentication

Every route needs the Clerk session: `Authorization: Bearer <token>`. A buyer
only ever reads and writes their own rows. Another user's id is never accepted,
and another user's item id is a 404. See [auth-api.md](auth-api.md).

---

## Shapes

### `WishlistItemView`: one saved row

```jsonc
{
  "id": "0b7e…",                       // WishlistItem id: use it for PATCH / DELETE /wishlist/:itemId
  "productId": "6f1c…",                // Drop id
  "variant": { "id": "9a2d…", "label": "Size M" },  // null = the drop as a whole
  "notifyOnAvailable": false,          // "tell me when it's available"
  "note": null,                        // the buyer's own note, ≤ 500 chars
  "addedAt": "2026-11-18T10:00:00.000Z",
  "product": WishlistDropCard          // see below; null only if the drop row is gone
}
```

### `WishlistDropCard`

This is the same card as Discover and Marketplace, plus the drop's **current state**:

```jsonc
{
  "id": "6f1c…", "name": "Lucky in Pink", "description": null,
  "imageUrl": "https://…", "rarity": "UNCOMMON", "category": "FIGURE",
  "artist": { "id": "a91e…", "name": "Yuki Lab", "slug": "yuki-lab" },
  "price": { "amount": "110.00", "currency": "USD", "isFree": false },
  "totalSupply": 150, "mintedCount": 9, "rewardPoints": 550,

  "status": "ACTIVE",                  // DropStatus right now
  "isViewable": true,                  // GET /products/:id would show it
  "isPurchasable": true,               // POST /checkout would accept it right now (stock aside)
  "unavailableReason": null,           // why not, when isPurchasable is false (table below)
  "variants": [                        // non-archived variants, display order; [] if none
    { "id": "9a2d…", "label": "Size M", "isActive": true }
  ]
}
```

| `unavailableReason` | Meaning | Suggested label |
|---|---|---|
| `REMOVED` | Switched off or archived by HitBox | "No longer available" |
| `NOT_ON_SALE` | Not on sale, for example `ENDED` or still in review | "Sold out" / "Ended" |
| `NOT_RELEASED_YET` | Release window has not opened | "Coming soon" |
| `CLOSED` | Release window has closed | "Ended" |
| `NO_PRICE` | No price for the default market | "Unavailable" |
| `null` | Can be bought | show **Add to cart** |

There is no `isWishlisted` on these cards. Everything on this screen is wishlisted.

---

## Endpoints

### `GET /api/v1/wishlist`

| Param | Values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ WishlistItemView, … ],
  "meta": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
}
```

Rows stay on the list when their drop ends or is switched off. Use `product.status`
and `product.isPurchasable` to grey them out.

### `POST /api/v1/wishlist`: heart on

```json
{ "productId": "6f1c…", "variantId": "9a2d…", "notifyOnAvailable": true, "note": "for Sam" }
```

| Field | Rule |
|---|---|
| `productId` | required, uuid. The drop must be viewable (`PUBLISHED`, `ACTIVE` or `ENDED`, switched on, not archived). |
| `variantId` | optional, uuid. Must be one of the drop's non-archived variants. Omit to save the drop as a whole. |
| `notifyOnAvailable` | optional boolean, default `false` |
| `note` | optional string ≤ 500, or `null` |
| anything else | rejected (422) |

Response: **201** `{ "data": WishlistItemView }` when it was added, **200** with the
existing row when it was already saved. Sending `notifyOnAvailable` or `note` with
an existing row updates them, so a double tap is harmless.

A drop that has ended can still be saved. A wishlist is not a cart.

### `DELETE /api/v1/wishlist/products/:productId`: heart off

Removes the drop from the wishlist by the **drop id**, which is what a card has.

| Param | Values | Default |
|---|---|---|
| `variantId` (query) | uuid | none: removes **every** row for the drop, whatever the variant |

```json
{ "data": { "removed": 1 } }
```

This is always **200**, even when nothing was saved (`removed: 0`), so the heart can
be toggled freely.

### `PATCH /api/v1/wishlist/:itemId`

```json
{ "notifyOnAvailable": true, "note": null }
```

At least one of the two fields is required. `note: null` clears the note.
Response: `{ "data": WishlistItemView }`.

### `DELETE /api/v1/wishlist/:itemId`

Removes one row. Response: **204** with no body.

### Errors

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_…` | No or bad session ([README.md](README.md#authentication)) |
| 404 | `SOCIAL_PRODUCT_NOT_FOUND` | `POST`: no such drop, or it is not viewable (draft, in review, archived, switched off) |
| 404 | `SOCIAL_VARIANT_NOT_FOUND` | `POST`: the variant is not one of this drop's |
| 404 | `SOCIAL_WISHLIST_ITEM_NOT_FOUND` | `PATCH` / `DELETE /:itemId`: no such row **of yours** |
| 422 | `VALIDATION_ERROR` | Not a uuid, note too long, unknown field, empty PATCH |

---

## How it works

### The heart, end to end

```text
Card shows isWishlisted (Discover / Marketplace, signed in)
   │
   ├─ false → tap → POST /wishlist { productId }                 → heart filled
   └─ true  → tap → DELETE /wishlist/products/:productId          → heart empty
```

Both calls are idempotent, so the app can update the heart immediately and send
the request in the background. Discover and Marketplace read `isWishlisted` from
the same table on every request, uncached, so the next feed load agrees.

### One row per drop and variant

A buyer has at most one row per (drop, variant). Saving "Size M" and "Size L" of
the same drop gives two rows. Saving the drop with no variant gives one more row.
The heart's "off" with no `variantId` removes all of them.

### Notify on available

`notifyOnAvailable` is stored so the app can show the toggle, but **nothing sends
the alert yet**. See Known limitations.

---

## Known limitations

- **No alerts are sent.** `notifyOnAvailable` is saved, but no job watches for
  drops coming on sale.
- **Two simultaneous "save" taps on a drop with no variant can create two rows.**
  The database's unique rule treats an empty variant as distinct each time. The
  list shows both, and the heart's "off" removes both. With a variant, the
  database prevents the duplicate.
- **No "move to cart" endpoint.** Call `POST /cart` with the same
  `productId`/`variantId` ([cart-api.md](cart-api.md)), then remove the row if wanted.
