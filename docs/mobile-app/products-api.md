# Products — API

The public drop catalog. The app uses it for the **product details** screen
(after a tap on any Discover, Marketplace or Collection card) and for plain
catalog lists filtered by artist, collection or facet.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/products` | public | Paginated, filtered drop list |
| `GET` | `/api/v1/products/:id` | public | One drop by id (product details) |
| `GET` | `/api/v1/products/code/:groupCode` | public | One drop by its 12-digit group code |

Code: `packages/products` (`createRouter`, `ProductController`,
`ProductService.toResponse`, `ProductRepository.findMany`,
`dto/product.dto.ts`).

"Drop" and "product" mean the same thing here. The table is `Drop`; the routes
still say `products`.

---

## Authentication

All three routes are **public**. A token is ignored: nothing in the response
depends on who is asking. See [auth-api.md](auth-api.md).

---

## Shapes

### `Product`: one drop

All three endpoints return this shape.

```jsonc
{
  "id": "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",  // uuid; use for GET /products/:id
  "groupCode": "483920170042",                   // 12 digits, unique
  "name": "Cosmic Voyager #001",
  "description": "Beyond the ordinary.",         // null if not set
  "vertical": "COLLECTIBLES",                     // free-form; null if not set
  "category": "FIGURE",                           // free-form; null if not set
  "rarity": "ULTRA_RARE",                         // free-form; null if not set
  "status": "ACTIVE",                             // DropStatus (see How it works)
  "complianceStatus": "CLEARED",                  // PENDING | CLEARED | FLAGGED; set by the releases reviewer
  "totalSupply": 200,                             // edition size
  "purchaseLimit": 2,                             // per buyer; null = unlimited
  "rewardPoints": 2400,                           // 0 when none set
  "releaseStart": "2026-11-01T00:00:00.000Z",    // ISO 8601 or null
  "releaseEnd": "2026-12-01T00:00:00.000Z",      // ISO 8601 or null
  "publishedAt": "2026-10-28T15:04:11.000Z",     // ISO 8601 or null
  "isAgeSpecific": false,
  "minimumAge": null,                             // int when isAgeSpecific
  "oddsDisclosureRef": null,                      // for randomised drops
  "isActive": true,
  "archivedAt": null,                             // ISO 8601 when soft-deleted
  "createdAt": "2026-10-20T09:12:45.000Z",
  "updatedAt": "2026-10-28T15:04:11.000Z",
  "collectionId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", // null if none
  "artistId": "a91e2b3c-4d5e-4f60-9a7b-8c9d0e1f2a3b",     // null if none
  "artistName": "Studio Nova",                    // drop's artist, else its collection's artist; null if none
  "organizationId": "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f", // owning brand/org; null if none
  "images": [                                     // public URLs, primary first; [] if none
    "https://cdn.example.com/drop-images/6f1c/front.webp",
    "https://cdn.example.com/drop-images/6f1c/back.webp"
  ],
  "availableInMarket": true,                      // false only when ?marketId was sent and the drop has no price there
  "unavailableReason": null,                      // "NOT_AVAILABLE_IN_REGION" when availableInMarket is false
  "price": {                                      // base price of ?marketId (that market only), else the default market; null when none
    "amount": "480.00",                           // 2-decimal string; "0.00" when free
    "currency": "USD",                            // USD | INR | GBP
    "isFree": false
  },
  "dropType": {                                   // null for a legacy (untyped) drop
    "code": "TSHIRT",
    "name": "T-Shirt",
    "variantMode": "REQUIRED"                     // whether the drop must have variants
  },
  "variants": [                                   // active-or-not, non-archived; [] if none
    {
      "id": "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "variantCode": "SIZE-L",
      "label": "Large",
      "optionName": "size",                       // legacy single-dimension fields
      "optionValue": "L",
      "options": [                                // per-dimension breakdown
        { "dimension": "SIZE", "value": "L", "label": "Large", "hexCode": null },
        { "dimension": "COLOR", "value": "BLACK", "label": "Black", "hexCode": "#000000" }
      ],
      "totalSupply": 50,                          // null = not capped per variant
      "isActive": true
    }
  ]
}
```

How the details screen maps onto the fields:

| On screen | Field |
|---|---|
| Image gallery | `images` (index 0 is the primary) |
| Title | `name` |
| `by STUDIO NOVA` | `artistName` |
| Rarity badge | `rarity`: replace `_` with a space and uppercase. Hide when `null`. |
| Price / "Free" | `price.amount` + `price.currency`, or "Free" when `price.isFree`. Hide when `price` is `null`. |
| `Edition of 200` | `totalSupply` |
| `★ 2,400 pts` | `rewardPoints` |
| Size / color pickers | `variants[].options` grouped by `dimension`; color swatch from `hexCode` |
| "Limit 2 per buyer" | `purchaseLimit` |
| Age gate | `isAgeSpecific` + `minimumAge` |

`vertical`, `category` and `rarity` are free-form text the admin types in.
Format them for display; do not switch on them as a fixed enum.

---

## Endpoints

### `GET /api/v1/products`

A paginated list of public drops. All params are optional.

| Param | Type | Allowed values | Default |
|---|---|---|---|
| `page` | int | ≥ 1 | `1` |
| `limit` | int | 1–100 | `20` |
| `category` | string | 1–64 chars, exact `Drop.category` value, e.g. `FIGURE` | none |
| `vertical` | string | 1–64 chars, exact `Drop.vertical` value | none |
| `rarity` | string | 1–64 chars, exact `Drop.rarity` value, e.g. `ULTRA_RARE` | none |
| `status` | enum | `DRAFT` `SUBMITTED` `IN_REVIEW` `APPROVED` `REJECTED` `PUBLISHED` `ACTIVE` `ENDED` `ARCHIVED` | none (public rule) |
| `collectionId` | uuid | an artist collection id | none |
| `artistId` | uuid | an artist id | none |
| `search` | string | 1–100 chars, case-insensitive "name contains" | none |
| `sort` | enum | `newest` `popular` | `newest` |

`category` here is the **raw** stored value (`TRADING_CARD`, `FIGURE`, …), not
the screen chip (`cards`, `figures`). For chip filtering use
[marketplace-api.md](marketplace-api.md) or [discover-api.md](discover-api.md).

The mobile app should **not** send `status`. See How it works.

```http
GET /api/v1/products?artistId=a91e2b3c-4d5e-4f60-9a7b-8c9d0e1f2a3b&sort=popular&limit=10
```

```jsonc
{
  "data": [ Product, … ],
  "meta": { "page": 1, "limit": 10, "total": 12, "totalPages": 2 }
}
```

`totalPages` is at least `1`, even when `total` is `0`.

| Status | Code | When |
|---|---|---|
| 422 | `VALIDATION_ERROR` | `limit` > 100, a non-uuid `artistId`/`collectionId`, unknown `sort` or `status`, an empty or too-long string |

### `GET /api/v1/products/:id`

One drop. This is the product details call after a card tap.

| Param | In | Type | Notes |
|---|---|---|---|
| `id` | path | uuid | `Drop.id`, as returned by every card (`id`) |
| `marketId` | query | uuid | optional. Price in this market; see [Market selection](#market-selection) |

```jsonc
{ "data": Product }
```

| Status | Code | When |
|---|---|---|
| 404 | `PRODUCTS_NOT_FOUND` | No drop with this id |
| 500 | `INTERNAL_ERROR` | `id` is not a valid uuid (see Known limitations) |

### `GET /api/v1/products/code/:groupCode`

One drop by its group code.

| Param | In | Type | Notes |
|---|---|---|---|
| `groupCode` | path | string | 12 digits, e.g. `483920170042` |
| `marketId` | query | uuid | optional. Price in this market; see [Market selection](#market-selection) |

```jsonc
{ "data": Product }
```

| Status | Code | When |
|---|---|---|
| 404 | `PRODUCTS_NOT_FOUND` | No drop with this code |

For NFC tag taps, do not use this route. Use the claims module's
`GET /api/v1/verify/:tagId` and `GET /api/v1/ledger/:tagId`
(see [../nfc-claim-verify-api.md](../nfc-claim-verify-api.md)).

### Write endpoints (not used by the app)

Creating, editing, archiving, publishing, pricing and imaging drops are
**not** on `/products`. They live under `/api/v1/admin/products`
(`POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/publish`,
`PUT /:id/reward-points`, the `/:id/prices` and `/:id/images` routes, …).
They need a signed-in staff account with the `drop:manage` permission at
global scope (`drop:configure` for reward points). A buyer gets 403. The
mobile app never calls them. A `POST`/`PATCH`/`DELETE` to `/api/v1/products`
returns 404 `NOT_FOUND`.

---

## How it works

### Which drops the list shows

`GET /products` with no `status` param returns a drop only when **all three**
are true:

| Condition | Why |
|---|---|
| `status = ACTIVE` | The drop is live. All other statuses are hidden, including `PUBLISHED`. |
| `isActive = true` | The admin kill switch is off. |
| `archivedAt = null` | The drop is not soft-deleted. |

This is the same public rule as Discover and Marketplace.

Then each param you sent narrows the list further (all are ANDed):

1. `category`, `vertical`, `rarity`: exact, **case-sensitive** match on the
   column. `rarity=ultra_rare` does not match `ULTRA_RARE`.
2. `collectionId`, `artistId`: exact match on the drop's own column.
   `artistId` does **not** match drops that only get their artist through
   their collection.
3. `search`: the name contains the text, ignoring case.

If you send `status`, the rule becomes `status = <value>` **and**
`isActive = true` **and** `archivedAt = null`. That is meant for admin
tooling, so the app should never send it.

### Detail visibility

`GET /products/:id` and `GET /products/code/:groupCode` return a drop only when
**all** of these are true:

| Condition | Why |
|---|---|
| `status` is `PUBLISHED`, `ACTIVE` or `ENDED` | `ENDED` stays visible so a buyer can open an item they own from My Collection. `PUBLISHED` can be previewed before release. |
| `isActive = true` | The admin kill switch is off. |
| `archivedAt = null` | The drop is not soft-deleted. |

Anything else (`DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`,
`ARCHIVED`, switched off or archived) returns **404 `PRODUCTS_PRODUCT_NOT_FOUND`**,
exactly like an id that does not exist. The response does not reveal that an
unreleased drop exists.

### Ordering

| `sort` | Order |
|---|---|
| `newest` | `createdAt`, newest first |
| `popular` | number of minted SKUs (physical units) for the drop, most first |

There is no tie-breaker. Drops with the same count (or the same `createdAt`)
can swap between requests, so a drop could repeat or be skipped across pages.

`popular` is minted units, not sales. The schema has no sales counter.

### Price

`price` is the drop's **base price** (no variant) in the market chosen with
`?marketId=` (else the **default market**), and only when that price row is
`ACTIVE` and the market is active. `price.marketId` says which market it is.
With a market selected and no price there, `price` is `null` and
`availableInMarket` is `false` (see [Market selection](#market-selection)). With
no market, a drop with no default-market price also has `price: null`, even if
variant prices exist. Applies to `GET /products/:id` and
`GET /products/code/:groupCode`; the plain list keeps the default market.

### Caching

Results are cached. A list is cached for **30 seconds**. A single drop (by id
or code) is cached for **5 minutes**. An admin edit can take that long to
show.

---

## Market selection

Send the buyer's market as **`?marketId=<uuid>`** (an id from `GET /markets`) on
`GET /products/:id` and `GET /products/code/:groupCode`.

- **Sold in that market:** `price` is that market's base price, `price.marketId`
  is the selected market, `availableInMarket` is `true`.
- **Not sold in that market:** the drop is still returned (200, so the screen can
  open), but `price` is `null`, `availableInMarket` is `false` and
  `unavailableReason` is `"NOT_AVAILABLE_IN_REGION"`. Show **"This product is not
  available in your region"** and disable buying. The price is **never** taken
  from another market.
- **No `marketId`**, or a non-uuid, unknown or inactive one: ignored, never an
  error. `price` is the default market's, `availableInMarket` is `true`.
- `GET /products` (the plain list) does not take a market and shows the default
  market's price.

## Known limitations

- **Detail shows more than the feeds do.** `/products/:id` and
  `/products/code/:groupCode` also return `PUBLISHED` and `ENDED` drops (see
  "Detail visibility"), so check `status === "ACTIVE"` before offering "Buy".
- **The list accepts `status`** from anyone, so unpublished (but not archived)
  drops can be listed through the public route.
- **A non-uuid `id` returns 500, not 404.** The route does not validate the id
  format before the database does.
- **No price sorting.** `price_asc`/`price_desc` were removed. Price lives in a
  per-market table and cannot be used in `ORDER BY` here.
- **Market selection is on the two detail routes only.** `GET /products` (the list) always uses the default market's price.
- **`variants` includes inactive variants.** Filter on `isActive` before
  showing pickers.
