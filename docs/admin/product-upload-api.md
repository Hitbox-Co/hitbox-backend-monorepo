# Product Upload & Images API

> Creating a drop, what the request body may actually look like, market
> pricing, and the image gallery.
>
> Serialized units and NFC tags: [sku-api.md](sku-api.md).
> Session handling and the Clerk flow: [authentication.md](authentication.md).
> The rest of the admin write surface: [admin-write-apis.md](admin-write-apis.md).

---

## 1. If you are getting `422` on create — read this first

**It is not your account.** A `422 VALIDATION_ERROR` is returned *after*
authentication and authorization have both passed. A System Admin whose grant
was wrong would get `401` or `403 AUTHZ_FORBIDDEN`, never `422`. So a 422 means
the session and the capability were fine and the **request body** was refused.

The schema used to reject seven shapes that ordinary clients send. All seven
are now accepted:

| What you send | Before | Now |
|---|---|---|
| `"totalSupply": "500"` (number as string) | ❌ 422 | ✅ → `500` |
| `"isAgeSpecific": "false"` | ❌ 422 | ✅ → `false` |
| `"description": ""` (blank field) | ❌ 422 | ✅ → `null` |
| `"artistId": null` (nothing selected) | ❌ 422 | ✅ → `null` |
| `"status": "draft"` (lower case) | ❌ 422 | ✅ → `DRAFT` |
| `"groupCode": "123456780042"` (the 12-digit code the API returned) | ❌ 422 | ✅ → `0042` |
| `"skus": { "count": "500" }` | ❌ 422 | ✅ → `500` |

Two notes on the subtle ones:

- **`"false"` really becomes `false`.** The obvious implementation,
  `z.coerce.boolean()`, applies `Boolean(value)` — and `Boolean("false")` is
  `true`, so the single most common wire spelling of false would have silently
  flipped every age-gated drop. Accepted spellings are `true`/`false`,
  `"true"`/`"false"`, `1`/`0`, `"1"`/`"0"`.
- **`groupCode` takes a 4-digit suffix but the API returns 12 digits.** The
  server generates 8 random digits and appends your suffix. A client
  round-tripping the value it was handed is therefore sending 12 digits, so the
  12-digit form is now accepted and its last four taken.

### What is still rejected, and should be

`totalSupply: "lots"`, `artistId: "not-a-uuid"`, `status: "LAUNCHED"`,
`name: "   "`, `groupCode: "123"`, `totalSupply: -1`, and any unknown key
inside `skus` or `images`. Leniency about *format* is not leniency about
*content*.

### Reading a 422 body

Validation errors now report what arrived, not just what was expected:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "path": "totalSupply",
        "message": "Expected number, received nan",
        "code": "invalid_type",
        "receivedType": "string",
        "received": "lots"
      }
    ]
  }
}
```

`received` is truncated to 60 characters and omitted for objects and arrays —
a validation error on an address or a token should not echo it into logs.

### `400 BODY_REQUIRED` — the other one that looked like nothing

```json
{
  "error": {
    "code": "BODY_REQUIRED",
    "message": "No request body was parsed. Send a JSON body with Content-Type: application/json.",
    "details": {
      "contentType": "text/plain;charset=UTF-8",
      "hint": "The Content-Type is not application/json, so the JSON body parser skipped this request."
    }
  }
}
```

Express 5 leaves `req.body` as `undefined` when no parser matched, where
Express 4 gave `{}`. Previously that surfaced as a `422` whose only detail was
`"": "Required"` — pointing at no field, with no clue that the real problem was
a missing `Content-Type: application/json` header. It now says so.

---

## 2. `POST /api/v1/admin/products`

**Capability:** `drop:manage` at `GLOBAL` scope. Today `HITBOX_SYSTEM_ADMIN`
and `HITBOX_DROP_MANAGER` hold it — see
[admin-write-apis.md 0](admin-write-apis.md).

```http
POST /api/v1/admin/products
Authorization: Bearer <clerk session token>
Content-Type: application/json
```

```json
{
  "name": "Neon Drift — Series 2",
  "description": "Hand-finished resin figure.",
  "vertical": "figures",
  "category": "collectible",
  "rarity": "limited",
  "artistId": "6b5f3a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  "organizationId": "9f8e7d6c-5b4a-3928-1706-fedcba987654",
  "totalSupply": 500,
  "purchaseLimit": 2,
  "releaseStart": "2026-10-01T09:00:00.000Z",
  "isAgeSpecific": false,
  "groupCode": "0042",

  "skus": { "count": 500 },

  "prices": [
    { "marketCode": "IN", "amount": "1999.00", "costOfGoods": "640.00" },
    { "marketCode": "US", "amount": "24.99" }
  ],

  "images": [
    { "assetId": "aaaa1111-…", "isPrimary": true, "altText": "Front" },
    { "assetId": "bbbb2222-…", "altText": "Back" }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string 1–255 | **yes** | trimmed |
| `description` | string ≤5000 | no | `""`/`null` → `null` |
| `vertical` / `category` / `rarity` | string ≤64 | no | free-form, not enums |
| `collectionId` / `artistId` / `organizationId` | uuid | no | `null` detaches on PATCH |
| `totalSupply` | int ≥ 0 | no (`0`) | `0` = size not declared yet |
| `purchaseLimit` | int ≥ 1 | no | omit for unlimited |
| `releaseStart` / `releaseEnd` | ISO date | no | |
| `status` | `DropStatus` | no (`DRAFT`) | case-insensitive |
| `isAgeSpecific` | boolean | no (`false`) | |
| `minimumAge` | int 0–120 | no | |
| `oddsDisclosureRef` | string ≤500 | no | required for randomised drops |
| `groupCode` | 4 or 12 digits | no (`0000`) | the **group suffix** |
| `skus.count` | int 1–1000 | no | mints the edition in the same transaction |
| `prices[]` | 1–200 entries | **yes** | at least one market price — see §3 |
| `images[]` | ≤24 entries | no | attaches uploaded assets as the gallery |

Everything in `prices`, `skus` and `images` is written in the **same
transaction** as the product. The request either produces a complete drop —
catalog row, pricing, units, gallery — or produces nothing.

**Response `201`** carries the product, plus `skus` when units were minted.
`images` on the product body is the array of URLs, as everywhere else.

```json
{
  "data": {
    "id": "0f1e2d3c-…",
    "groupCode": "123456780042",
    "name": "Neon Drift — Series 2",
    "status": "DRAFT",
    "totalSupply": 500,
    "images": ["https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/drop-images/…"],
    "skus": { "minted": 500, "firstSerial": 1, "lastSerial": 500, "skuCodes": ["…"], "tagsBound": 0 }
  }
}
```

**Asset ids and market references are validated before the product is
written.** A typo'd uuid or an unknown market code fails the request without
creating anything, so the whole payload does not have to be resubmitted to fix
one id.

Note the ordering inside the transaction: prices are written first, then units,
then the gallery. Pricing is the required part, so a failure there aborts
before 500 SKUs are minted.

---

## 3. Market pricing

### At least one price is compulsory

`prices` is **required** on `POST /admin/products`, with a minimum of one
entry. A drop with no price is not purchasable anywhere: the storefront reads
`ProductPrice` for the buyer's market and finds nothing to show and nothing to
charge. Every previous route to that state was a half-finished form, so the API
no longer allows it.

> ⚠️ **Breaking change.** A create that worked yesterday without `prices` now
> returns `422` with `prices: At least one market price is required`. Any
> existing client or script that creates drops needs a price block added.

### One price row per market

`ProductPrice` is scoped to `(product, variant, market)`. An admin prices the
drop once per market they sell in:

```json
{
  "prices": [
    { "marketCode": "IN", "amount": "1999.00", "costOfGoods": "640.00" },
    { "marketCode": "US", "amount": "24.99",   "costOfGoods": "8.10" },
    { "marketCode": "GB", "amount": "19.99" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `marketId` | uuid | **exactly one of** `marketId` or `marketCode` |
| `marketCode` | string | `IN`, `US`, `GB` — matched case-insensitively |
| `amount` | decimal string or number | required **unless** `isFree` |
| `isFree` | boolean | default `false`. Cannot be combined with `amount` |
| `costOfGoods` | decimal string or number | unit cost, so finance computes margin without re-deriving it |
| `status` | `ACTIVE` \| `DISABLED` | default `ACTIVE`; `DISABLED` stages a price without making it live |
| `variantId` | uuid | price one variant instead of the product as a whole |

### There is no `currency` field, and that is deliberate

The currency is the **market's** (`Market.currency`). Accepting one per price
would let a drop be quoted in GBP inside a market that settles in INR, and no
constraint in the schema would catch it. Send the amount; read the currency
back off the response.

```json
{ "marketCode": "IN", "amount": "1999.00" }   →   currency: "INR"
```

### Money stays a string

`amount` and `costOfGoods` accept a number or a string and are carried to the
database **as strings**. A price that round-trips through a JavaScript float
can arrive as `1999.9899999999998`, and `Decimal(12, 2)` would round it
silently — on the column that decides what a buyer is charged. Send strings if
you can; the column holds up to 10 digits and 2 decimal places.

### `GET /admin/products/:id/prices`

Capability `drop:read`. Base prices first, then variant prices, each by market
code.

```json
{
  "data": [
    {
      "priceId": "p1p1p1p1-…",
      "marketId": "5a9e…",
      "marketCode": "IN",
      "marketName": "India",
      "currency": "INR",
      "amount": "1999.00",
      "isFree": false,
      "costOfGoods": "640.00",
      "status": "ACTIVE",
      "variantId": null,
      "createdAt": "2026-09-21T10:04:22.118Z",
      "updatedAt": "2026-09-21T10:04:22.118Z"
    }
  ]
}
```

`amount` is `"0"` for a free price, and `null` only for a row that carries
neither — which the API will not create.

### `PUT /admin/products/:id/prices` — replace the price list 🔒 platform-wide

```json
{
  "prices": [
    { "marketCode": "IN", "amount": "2199.00" },
    { "marketCode": "US", "amount": "24.99" }
  ]
}
```

Replaces the list wholesale: markets present before and absent now are removed.
This is the endpoint the pricing table saves to — a table is edited as a whole,
and "these are the prices now" is the only statement that can express *dropping
a market*.

The minimum of one still applies, so this can never de-price a drop.

### `PATCH /admin/products/:id/prices/:priceId` 🔒 platform-wide

Edit one row: `amount`, `isFree`, `costOfGoods` (`null` clears it), `status`.
The free/amount pair is re-checked against the **stored** row, so flipping
`isFree: false` on a row with no amount is refused rather than producing a
priced entry with nothing to charge.

### `DELETE /admin/products/:id/prices/:priceId` 🔒 platform-wide

Removes one market's price. **Refused when it is the last one** —
`409 PRODUCTS_PRICE_REQUIRED`. To stop selling in every market without
deleting the pricing, set the rows to `status: "DISABLED"` instead.

Deletion here is a real delete, not an archive. Unlike a gallery placement, a
price point carries no history worth keeping: an order snapshots `unitPrice`,
`amount` and `currency` at purchase time, so nothing downstream ever reads back
through this row.

### One caveat worth knowing

`@@unique([productId, variantId, marketId])` does **not** actually prevent two
base prices for the same market. `variantId` is nullable, and in Postgres NULLs
never collide in a unique index — so the constraint silently does not apply to
the most common row shape. Duplicates are therefore rejected in the API layer,
both in the payload and when matching existing rows. If you write to
`ProductPrice` by any other route, that guarantee is not there for you.

### Which market does a buyer get?

The storefront resolves the buyer's country to a market through
`MarketCountry`, and falls back to the **default** market when the country maps
nowhere. A drop priced only in `IN` is therefore invisible to a US buyer's
price lookup. Price the markets you intend to sell in; see
[admin-write-apis.md §1](admin-write-apis.md) for market administration.

---

## 4. Images

`ProductImage` joins a product to a `MediaAsset`. The **file** belongs to the
media module; these endpoints only arrange **where it sits** on the drop —
which is why `assetId` is the only required field.

### The upload flow, end to end

```
1. POST /api/v1/admin/media/upload-url     → { assetId, uploadUrl, key }
2. PUT  <uploadUrl>   (browser → S3 directly, no backend hop)
3. POST /api/v1/admin/products/:id/images  { images: [{ assetId, … }] }
```

Step 1 needs `assetType: "DROP_IMAGE"` — that is the only asset type a product
gallery accepts, and the only product-facing prefix (`drop-images/`) with
public read. Attaching an `EXCLUSIVE_CONTENT` or `LEGAL_DOCUMENT` asset would
produce a gallery URL that `403`s for every shopper, so it is refused at attach
time rather than rendering as a permanently broken image. See
[media/s3-configuration.md](../media/s3-configuration.md).

### `GET /admin/products/:id/images`

Capability `drop:read`.

```json
{
  "data": [
    {
      "imageId": "c1c1c1c1-…",
      "assetId": "aaaa1111-…",
      "url": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/drop-images/2026/09/front.jpg",
      "storageRef": "drop-images/2026/09/front.jpg",
      "position": 0,
      "isPrimary": true,
      "altText": "Front",
      "createdAt": "2026-09-15T10:04:22.118Z"
    }
  ]
}
```

`url` is `null` on a deployment with no bucket configured; `storageRef` is
always present so a client can build its own URL if it must.

### `POST /admin/products/:id/images` — append 🔒 platform-wide

```json
{ "images": [ { "assetId": "bbbb2222-…", "altText": "Back", "isPrimary": false } ] }
```

→ `201` with the **whole** gallery.

Re-attaching an asset already in the gallery is a `409
PRODUCTS_IMAGE_DUPLICATE` — usually a double-submit, and silently moving the
existing entry would hide that. Re-attaching one that was previously *removed*
succeeds and revives it.

### `PUT /admin/products/:id/images` — replace 🔒 platform-wide

```json
{
  "images": [
    { "assetId": "bbbb2222-…", "position": 0, "isPrimary": true },
    { "assetId": "aaaa1111-…", "position": 1 }
  ]
}
```

Replaces the gallery wholesale. **This is the endpoint a drag-and-drop reorder
should call**: after a reorder the client knows the final state, not the
sequence of moves that produced it. An empty array clears the gallery — a
legitimate thing to want, and impossible to express with a merge.

Assets present before and absent now are archived, not deleted; the
`MediaAsset` is never touched.

### `PATCH /admin/products/:id/images/:imageId` 🔒 platform-wide

```json
{ "isPrimary": true }
```

Any of `position`, `isPrimary`, `altText`. Returns the whole gallery.

### `DELETE /admin/products/:id/images/:imageId` 🔒 platform-wide

Soft-removes the placement and returns the remaining gallery. If the removed
image was primary, **the next one is promoted automatically** — a drop with a
gallery and no primary renders with no image at all.

### The two invariants, enforced on every write

Neither is expressible in the schema (`position` is a plain `Int`, `isPrimary`
a plain `Boolean`), and both render wrong rather than failing loudly, so both
are normalised server-side every time:

1. **Positions are contiguous, 0-first.** Send `0, 5, 5, 11` and you get back
   `0, 1, 2, 3` in that relative order. Explicit `position` wins; entries
   without one keep their arrival order after the positioned ones.
2. **Exactly one image is primary.** Two claimants → the first wins and the
   second is demoted (rather than a 422, because "make this the cover" is the
   obvious intent). No claimant → position 0 gets it.

This is why every gallery mutation returns the **entire** gallery: a response
carrying only the row you touched would leave the client guessing what
cascaded, and guessing wrong on every reorder.

---

## 5. Errors

| HTTP | `code` | Raised when |
|---|---|---|
| `400` | `BODY_REQUIRED` | no JSON body was parsed — check `Content-Type` |
| `400` | `PRODUCTS_MINTING_UNAVAILABLE` | `skus` sent but no minting provider wired in |
| `400` | `PRODUCTS_SUPPLY_EXCEEDED` | `skus.count` > `totalSupply` in the same payload |
| `400` | `PRODUCTS_MEDIA_UNAVAILABLE` | `images` sent on a deploy with no bucket configured |
| `400` | `PRODUCTS_MARKETS_UNAVAILABLE` | no market-lookup provider is wired in |
| `400` | `PRODUCTS_PRICE_MARKET_INVALID` | market missing, archived, inactive, or a foreign `variantId` |
| `400` | `PRODUCTS_IMAGE_ASSET_INVALID` | asset missing, archived, or not a `DROP_IMAGE` |
| `403` | `AUTHZ_FORBIDDEN` | grant is organization-scoped, not `:global` |
| `404` | `PRODUCTS_NOT_FOUND` | no such drop |
| `404` | `PRODUCTS_IMAGE_NOT_FOUND` | no such placement on this drop |
| `409` | `PRODUCTS_IMAGE_DUPLICATE` | asset already in this gallery |
| `409` | `PRODUCTS_PRICE_REQUIRED` | deleting the drop's only price |
| `404` | `PRODUCTS_PRICE_NOT_FOUND` | no such price point on this drop |
| `409` | `PRODUCTS_CODE_TAKEN` | five consecutive `groupCode` collisions |
| `422` | `VALIDATION_ERROR` | schema failure — see 1 |

`PRODUCTS_PRICE_MARKET_INVALID` reports **every** bad market at once — a
pricing table is filled in for several markets in one sitting, and one error
per submission is a poor way to find three typos:

```json
{ "error": {
    "code": "PRODUCTS_PRICE_MARKET_INVALID",
    "message": "Cannot price: XX: no such market; GB: market is archived",
    "details": null } }
```

`PRODUCTS_IMAGE_ASSET_INVALID` reports **every** bad asset at once, so a
twelve-image gallery does not need twelve submissions to surface twelve
problems:

```json
{ "error": {
    "code": "PRODUCTS_IMAGE_ASSET_INVALID",
    "message": "Cannot attach: aaaa1111-…: no such media asset; bbbb2222-…: assetType is LEGAL_DOCUMENT, expected one of DROP_IMAGE",
    "details": null } }
```

---

## 6. Checklist

- [ ] Send at least one entry in `prices` — a create without it is now a `422`
- [ ] Do **not** send `currency` on a price; read it back off the response
- [ ] Send money as strings (`"1999.00"`), not floats
- [ ] Save the pricing table with `PUT .../prices`, not N× `PATCH`
- [ ] Offer `status: "DISABLED"` rather than delete when stopping sales in a market
- [ ] Load `GET /admin/markets` to populate the market picker
- [ ] Send `Content-Type: application/json` — its absence is the `BODY_REQUIRED` case
- [ ] Upload assets with `assetType: "DROP_IMAGE"`; nothing else attaches
- [ ] Call `PUT .../images` after a drag-and-drop reorder, not N× `PATCH`
- [ ] Re-render the gallery from the response of every mutation — positions cascade
- [ ] Do not send `position` at all unless the user reordered; arrival order is respected
- [ ] Expect the primary flag to move on its own when you delete the primary image
- [ ] Read `details[].received` on a 422 before changing the payload by guesswork
