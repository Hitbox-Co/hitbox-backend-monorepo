# HitBox Backend — API Reference

Base URL (local): `http://localhost:<PORT>` (`PORT` from the root `.env`).
All module routes are versioned under **`/api/v1`**.

---

## Conventions

### Authentication

Protected endpoints require a **Clerk session JWT**:

```http
Authorization: Bearer <session-token>
```

(The `__session` cookie set by Clerk's browser SDKs is also accepted.)

The middleware verifies the token, resolves the local account, and rejects with:

| Status | Code | When |
|---|---|---|
| 401 | `AUTH_UNAUTHENTICATED` | no token provided |
| 401 | `AUTH_INVALID_TOKEN` | token invalid / expired |
| 401 | `AUTH_ACCOUNT_NOT_FOUND` | valid token but no local user row (webhook not processed yet) or account deleted |
| 403 | `AUTH_ACCOUNT_SUSPENDED` | account suspended |
| 403 | `AUTH_EMAIL_UNVERIFIED` | session valid, but the account's synced primary email is not verified |

### Response envelopes

```jsonc
// success
{ "data": … }                       // single resource
{ "data": [ … ], "meta": { … } }    // lists (meta = pagination)

// error — ALWAYS this shape
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": … } }
```

### Validation errors

Invalid input returns **422** with field-level details:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "path": "limit", "message": "Expected number, received nan" } ]
  }
}
```

### Common error codes

| Status | Code |
|---|---|
| 404 | `NOT_FOUND` (unknown route) |
| 422 | `VALIDATION_ERROR` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

### Rate limiting

Every `/api/v1/*` route is rate limited **per client IP**. The default budget is:

> **100 requests per 60 seconds** per IP — i.e. **~1.6 requests/second** sustained, with bursts of up to 100 within any 60-second window.

The 101st request in a window is rejected with **429 `RATE_LIMITED`** until the window resets. Every response carries the budget headers:

```http
RateLimit-Policy: 100;w=60
RateLimit-Limit: 100
RateLimit-Remaining: 99
RateLimit-Reset: 60          # seconds until the window resets
```

The window is shared across all backend instances via **Redis** (`REDIS_URL`); without Redis it falls back to a per-instance in-memory window. Tune the budget with `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (see getting-started).

```json
// 429 body
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later" } }
```

---

## Health

### `GET /`
Liveness of the process. → `{ "success": true, "message": "HitBox Backend is running 🚀" }`

### `GET /api/v1/health`
→ `{ "status": "ok", "uptime": 138.98 }`

---

## Auth Module — `/api/v1/auth`

### `POST /api/v1/auth/webhooks/clerk`

Clerk → backend webhook (configured in the Clerk Dashboard). **Not called by clients.**

Headers (set by Clerk/svix): `svix-id`, `svix-timestamp`, `svix-signature`.

Handled event types: `user.created`, `user.updated`, `user.deleted` — everything else is acknowledged and ignored. Deliveries are idempotent (replays with a known `svix-id` are no-ops).

| Status | Meaning |
|---|---|
| 200 `{ "received": true }` | processed (or ignored / duplicate) |
| 401 `AUTH_WEBHOOK_INVALID_SIGNATURE` | missing or invalid signature |

### `POST /api/v1/auth/registration/validate`

Server-side pre-flight validation the client runs **before** Clerk sign-up, so registration input is checked against the same rules the backend enforces and returns the standard error envelope. Public (no auth). **Creates nothing** — account creation, passwords, and the email verification code are all handled by Clerk.

```jsonc
// body — all fields except email are optional; unknown fields rejected (strict)
{
  "email": "buyer@example.com",   // required; trimmed + lowercased + format-checked
  "username": "liam_collects",    // 3–50 chars, letters/numbers/"_"/"."
  "firstName": "Liam",            // ≤ 100 chars
  "lastName": "Carter"            // ≤ 100 chars
}
```

```json
// 200 — input is well-formed and the email is free
{ "data": { "valid": true, "email": "buyer@example.com" } }
```

| Status | Code | When |
|---|---|---|
| 422 | `VALIDATION_ERROR` | bad email format, illegal username, or unknown field (field-level `details`) |
| 409 | `AUTH_EMAIL_TAKEN` | an account already exists for this email |

> Password strength is **not** validated here — the backend never receives passwords; Clerk's password policy rejects weak ones at sign-up.

### `GET /api/v1/auth/me` 🔒

The authenticated principal (contents of `req.auth`). `requireAuth` runs first and enforces: valid Clerk JWT, a local account that is **not** deleted (401) or suspended (403), and a **verified** primary email (403 `AUTH_EMAIL_UNVERIFIED`).

```json
{
  "data": {
    "accountId": "cmd0…",
    "clerkUserId": "user_2ab…",
    "email": "ayan@example.com",
    "role": "USER",
    "sessionId": "sess_2cd…"
  }
}
```

---

## Users Module — `/api/v1/users`

### `GET /api/v1/users/me` 🔒

Full own profile.

```json
{
  "data": {
    "id": "cmd0…",
    "handle": "ayan",
    "fullName": "Ayan Saha",
    "avatarUrl": "https://img.clerk.com/…",
    "bio": null,
    "createdAt": "2026-07-16T04:41:00.000Z",
    "email": "ayan@example.com",
    "phone": null,
    "role": "USER",
    "profileVisibility": "PUBLIC",
    "generalLocation": null,
    "preferredMarketId": null,
    "isActive": true,
    "updatedAt": "2026-07-16T04:41:00.000Z"
  }
}
```

> **Renamed with the schema:** `username` → `handle`, `firstName` + `lastName`
> → a single `fullName`, `state` → `isActive`. `rewardPoints` was removed with
> no replacement column.

### `PATCH /api/v1/users/me` 🔒

Update own profile. All fields optional; unknown fields rejected.

```jsonc
// body
{
  "handle": "ayan_2",              // 3–50 chars, letters/numbers/_/.
  "fullName": "Ayan Saha",         // 1–200 chars
  "avatarUrl": "https://…",        // valid URL
  "bio": "…",                      // ≤500 chars
  "phone": "+91…",                 // 5–32 chars
  "generalLocation": "Kolkata",    // ≤120 chars — coarse, never an address
  "profileVisibility": "PUBLIC"    // "PUBLIC" | "PRIVATE"
}
```

→ `200` with the updated `MeDto` (same shape as `GET /users/me`).

| Status | Code | When |
|---|---|---|
| 409 | `USERS_HANDLE_TAKEN` | handle already in use (was `USERS_USERNAME_TAKEN`) |

### `GET /api/v1/users/:id`

Public profile (no email/role/contact; soft-deleted users are 404).

```json
{ "data": { "id": "…", "handle": "…", "fullName": "…", "avatarUrl": "…", "bio": null, "createdAt": "…" } }
```

| Status | Code |
|---|---|
| 404 | `USERS_NOT_FOUND` |

---

## Discover Module — `/api/v1/discover`

Read-side feed for the mobile **Discover** screen. Public (no auth). Items are deliberately **lightweight cards** — id, title, one image — not full product details; the client fetches `GET /products/:id` when a card is opened.

```jsonc
// DiscoverProductItem — the only shape this module returns
{
  "id": "cmro…",
  "name": "Pierce The Veil — Signature Series",
  "imageUrl": "https://…"         // first product image, null if none
}
```

> **`rewardPoints` was removed.** `Product.rewardPoints` no longer exists in
> the schema and nothing replaced it, so the card was trimmed rather than
> padded with a constant `0`.

Sections used to map onto `Product.marketplaceStatus`, a curation column the
restructure removed. With nothing editorial left in the schema, each section is
now just an ordering over data that exists:

| `section` value | Ordering |
|---|---|
| `trending` | minted SKU count desc |
| `new_releases` | `createdAt` desc |
| `top_creators` | minted SKU count desc |

> `trending` and `top_creators` therefore return the **same order** today. That
> is deliberate rather than clever: separating them again needs a real signal —
> a curation column, or sales/view counters — not a different arbitrary sort.
> `unitsSold`, which drove the old ordering, no longer exists.

### `GET /api/v1/discover`

The whole Discover screen in **one round-trip** — featured carousel + every section, queried in parallel.

```json
{
  "data": {
    "featured":    [ DiscoverProductItem × ≤5 ],
    "trending":    [ DiscoverProductItem × ≤10 ],
    "newReleases": [ DiscoverProductItem × ≤10 ],
    "topCreators": [ DiscoverProductItem × ≤10 ]
  }
}
```

> `featured` currently reuses the trending section (top 5) — it becomes its own curation once products grow a featured flag.

### `GET /api/v1/discover/products`

Paginated list backing **"See All"** and the **search bar**.

| Param | Type / values | Default |
|---|---|---|
| `section` | `trending` `new_releases` `top_creators` | — (all `ACTIVE` products, newest first) |
| `search` | 1–100 chars, case-insensitive name match | — |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```json
{
  "data": [ DiscoverProductItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

---

## Marketplace Module — `/api/v1/marketplace`

Read-side feed for the mobile **Marketplace** screen. Browse routes are public. Like discover, items are **lightweight listing cards** — when a card is tapped, the client fetches the full product from **`GET /api/v1/products/:id`** (the products module owns all detail data: description, all images, collection, artist, claim status, provenance).

```jsonc
// MarketplaceListingItem — the only shape this module returns
{
  "id": "cmro…",
  "name": "Warped Tour 2026 Commemorative Box",
  "imageUrl": "https://…",          // first product image, null if none
  "artistName": "Blink-182",        // via the product's artist/collection, null if none
  "priceInDollars": "89.99",        // decimal string, or null when no price is set
  "currency": "USD"                 // market the price is quoted in, null with no price
}
```

> **`rewardPoints` and `badge` were removed.** `Product.rewardPoints` and
> `Product.marketplaceStatus` no longer exist in the schema and nothing
> replaced them, so the card advertises only fields the database can answer
> for. `priceInDollars` now comes from `ProductPrice` — the base price
> (no variant) in the **default market** — and is `null` when none is set,
> which is why `currency` travels with it.

Category tabs are screen-level values that map to one or more product categories:

`Product.category` is a free-form `String?` since the restructure (the
`ProductCategory` enum was removed), so these are the string values the tab
mapping expects. A product whose category is outside every list is reachable
only from "All Items".

| `category` value | Backing product categories |
|---|---|
| *(omitted)* | all — the "All Items" tab |
| `cards` | `TRADING_CARD`, `CARD_PACK` |
| `figures` | `FIGURE` |
| `apparel` | `JERSEY`, `ACCESSORY` |
| `posters` | `POSTER` |
| `digital` | `DIGITAL_ASSET` |
| `other` | `BOOK`, `AUTOGRAPH`, `GAME_BOX`, `OTHER` |

### `GET /api/v1/marketplace`

The whole Marketplace screen in **one round-trip**, sections queried in parallel.

```json
{
  "data": {
    "featured":    [ MarketplaceListingItem × ≤10 ],
    "newListings": [ MarketplaceListingItem × ≤10 ]
  }
}
```

- `featured` — active drops inside a declared release window, most-minted
  first. (Was "any marketplace status"; that curation column is gone.)
- `newListings` — newest active products.

> Bids, countdowns and **live auctions** belong to the P2P trading feature — they need their own models (listings, bids, escrow) and will extend this feed when that lands. Until then the client renders cards without the bid row.

### `GET /api/v1/marketplace/listings`

Paginated listings behind the **category tabs**, **search bar** and **"See All"**.

| Param | Type / values | Default |
|---|---|---|
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | — ("All Items") |
| `search` | 1–100 chars, case-insensitive name match | — |
| `sort` | `newest` `popular` | `newest` |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

> **`price_asc` / `price_desc` were removed.** Price moved to the
> market-scoped `ProductPrice` table and a query cannot be ordered by a field
> on a to-many relation. Restoring them needs a denormalized base-price column
> on `Product` or a raw-SQL join. `popular` was `Product.unitsSold` (gone) and
> is now minted-SKU count — a proxy for edition size, not sales.

```json
{
  "data": [ MarketplaceListingItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 16, "totalPages": 1 }
}
```

### Card tap → product details

The marketplace card intentionally carries no detail data. On tap:

```text
MarketplaceListingItem.id ──▶ GET /api/v1/products/:id
```

which returns the full product (description, all images, `artistName`, rarity, price, variants) — see the Products module below.

---

## Collections Module — `/api/v1/collections`

Backs the mobile **Collections** tab — a user's shelf of owned/claimed collectibles (`BuyerCollection`). Every item carries a per-item **visibility**: `PRIVATE` (default, owner-only) or `PUBLIC` (shown on the user's showcase).

Items enter a collection through the **claims flow** (NFC claim → collection entry) — there is deliberately no "add to collection" endpoint.

> **A shelf row points at a SKU, not a product.** `BuyerCollection.productId`
> became `skuId`, so an item is one serialized copy — #14 of 500 — and a buyer
> can hold several SKUs of the same drop. The product card is reached one hop
> further, as `sku.product`.

```jsonc
// CollectionItemDto — shelf row + the SKU + the product card
{
  "id": "cmro…",                    // collection-item id
  "visibility": "PUBLIC",           // "PUBLIC" | "PRIVATE"
  "acquiredAt": "2026-07-17T06:33:06.201Z",
  "sku": {
    "id": "cmro…",
    "skuCode": "SKU-0014",
    "serialNumber": 14,             // position in the edition
    "claimedStatus": "CLAIMED"
  },
  "product": {
    "id": "cmro…",                  // → GET /products/:id for full details
    "name": "Pierce The Veil — Signature Series Poster",
    "imageUrl": "https://…",        // first product image, null if none
    "rarity": "LEGENDARY"           // free-form string, nullable
  }
}
```

Changed with the schema: `totalClaimedNo` → `sku.serialNumber` (the real
edition position, not a counter that could drift), `addedAt` → `acquiredAt`,
`claimedStatus` moved from the product to the SKU, and `genre` / `rewardPoints`
are gone with no replacement column.

### `GET /api/v1/collections/me/stats` 🔒

Aggregated **stats section** for the authenticated user's Collections screen. All numbers are computed by aggregation over the live shelf rows.

```json
{
  "data": {
    "totalClaimedItems": 3,
    "totalArtistCollections": 2,
    "collectionProgress": { "owned": 3, "total": 20, "percentage": 15 }
  }
}
```

| Field | Meaning |
|---|---|
| `totalClaimedItems` | Count of the user's shelf rows (archived excluded), via aggregation. |
| `totalArtistCollections` | Distinct `ArtistCollection`s the user has **≥ 1** product from. |
| `collectionProgress.owned` | The user's items that belong to an `ArtistCollection`. |
| `collectionProgress.total` | Σ `maximumLimit` of those collections (see below). |
| `collectionProgress.percentage` | `round(owned / total × 100)`, clamped `0–100` (`0` when `total` is 0). |

**Collection Progress** measures how far the user is toward completing the collections they've started. Each `ArtistCollection` has a `maximumLimit` (how many collectibles it holds, **default 10**). If the user owns items across collections whose caps sum to `25` and they hold `10` of them, progress is `10 / 25 = 40%`.

> A collection only counts toward `totalArtistCollections` / progress once the user holds at least one product from it. Products not tied to any `ArtistCollection` count in `totalClaimedItems` but not in progress.

### `GET /api/v1/collections/me` 🔒

The authenticated user's own shelf — private items included. Most recently acquired first. Archived rows are excluded.

| Param | Type / values | Default |
|---|---|---|
| `visibility` | `PUBLIC` `PRIVATE` | — (both) |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

> The `genre` filter was removed — `ProductGenre` no longer exists in the schema.

```json
{
  "data": [ CollectionItemDto, … ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

### `PATCH /api/v1/collections/me/:skuId` 🔒

Toggle one owned item between showcase and private. `:skuId` is the **SKU's** id (not the collection-item id).

> **Was `:productId`.** Forced by the schema, not cosmetic: the shelf is keyed
> `[userId, skuId]`, and a buyer can hold several SKUs of one product, so a
> product id no longer identifies a single shelf row.

```jsonc
// body
{ "visibility": "PUBLIC" }   // or "PRIVATE"
```

→ `200` with the updated `CollectionItemDto`.

| Status | Code | When |
|---|---|---|
| 404 | `COLLECTIONS_ITEM_NOT_FOUND` | that SKU is not in *your* collection |

### `GET /api/v1/collections/user/:userId`

Another user's **public showcase** — `PUBLIC` items only, no auth required. Same query params as `/me` except `visibility` is ignored. Use this on profile screens.

```json
{
  "data": [ CollectionItemDto, … ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### Item tap → product details

Like discover and marketplace cards: `item.product.id ──▶ GET /api/v1/products/:id`.

---

## Products Module — `/api/v1/products`

### `GET /api/v1/products`

Public catalog listing — filtered, sorted, paginated. Public visibility means
`status = ACTIVE` **and** `isActive = true` **and** `archivedAt = null`; the
old single `ProductState` column was split into all three, and a row can carry
any combination.

`category`, `vertical` and `rarity` are free-form `String?` columns now — the
`ProductCategory` / `ProductType` / `ProductGenre` / `ProductRarity` enums were
removed, so these accept any 1–64 char value rather than a fixed set. `genre`
is gone entirely.

Query parameters (all optional):

| Param | Type / values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–100 | `20` |
| `category` | free-form string, 1–64 chars | — |
| `vertical` | free-form string, 1–64 chars (was `type`) | — |
| `rarity` | free-form string, 1–64 chars | — |
| `status` | `DRAFT` `SUBMITTED` `IN_REVIEW` `APPROVED` `REJECTED` `PUBLISHED` `ACTIVE` `ENDED` `ARCHIVED` | — (public default) |
| `collectionId` | uuid | — |
| `artistId` | uuid | — |
| `search` | 1–100 chars, case-insensitive name match | — |
| `sort` | `newest` `popular` | `newest` |

Passing an explicit `status` overrides the public default, so admin tooling can
list `DRAFT` / `IN_REVIEW` drops through the same endpoint. `price_asc` /
`price_desc` were removed for the reason given under Marketplace above.

```jsonc
{
  "data": [ {
    "id": "…",
    "groupCode": "123456780000",     // was productCode
    "name": "…",
    "status": "ACTIVE",
    "totalSupply": 500,
    "images": [ "https://…" ],        // resolved public URLs, primary first
    "price": { "amount": "149.99", "currency": "USD", "isFree": false },
    "artistName": "…",
    "variants": [ { "id": "…", "label": "…", "optionName": "size", "optionValue": "L" } ]
  } ],
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

`images` are fully-resolved public URLs. Product artwork lives under the
publicly readable `drop-images/` prefix, so these are permanent and render
directly — see [media/s3-configuration.md §7](media/s3-configuration.md).
`price` is the base price (no variant) in the **default market**, or `null`.

### `GET /api/v1/products/:id`
### `GET /api/v1/products/code/:groupCode`

Single product. → 404 `PRODUCTS_NOT_FOUND`.

> `GET /products/tag/:tagId` and `/products/tag/:tagId/history` **were
> removed**: NFC tags moved to `Sku.tagId` and the `ProductHistory` model moved
> into the claims module keyed by `skuId`. Use `GET /api/v1/verify/:tagId` and
> `GET /api/v1/ledger/:tagId` — see
> [nfc-claim-verify-api.md](nfc-claim-verify-api.md).

### `POST /api/v1/products` 🔒

Create a product. The 12-digit `groupCode` is **generated server-side**: 8 random digits + the 4-digit group suffix you supply.

```jsonc
// body
{
  "name": "Signed Tour Poster",           // required, 1–255
  "description": "…",
  "vertical": "MUSIC",                    // free-form, ≤64 (was `type`)
  "category": "POSTER",                   // free-form, ≤64
  "rarity": "RARE",                       // free-form, ≤64
  "totalSupply": 500,                     // int ≥ 0, default 0 (was inventoryUnit)
  "purchaseLimit": 2,                     // int > 0, omit for unlimited
  "collectionId": "cmd0…",                // uuid — links to an ArtistCollection
  "artistId": "cmd0…",                    // uuid
  "organizationId": "cmd0…",              // uuid
  "releaseStart": "2026-08-01",           // was releaseDate
  "releaseEnd": "2026-09-01",
  "status": "DRAFT",                      // default DRAFT
  "isAgeSpecific": false,                 // default false
  "minimumAge": 18,
  "oddsDisclosureRef": "…",               // required for randomised drops
  "groupCode": "0042"                     // exactly 4 digits, default "0000"
}
```

→ `201` with the created product.

**Removed from the body:** `genre`, `rewardPoints`, `priceInDollars`,
`marketplaceStatus`, `tagId` and `images` — none has a backing column any more.
Prices are rows in `ProductPrice` (per market/variant), images are created
through the media upload flow and joined via `ProductImage`, and tags belong to
`Sku`. `complianceStatus` is set to `PENDING` on create and is written by the
releases reviewer, not by a catalog edit.

| Status | Code | When |
|---|---|---|
| 409 | `PRODUCTS_CODE_TAKEN` | could not allocate a unique code (after retries) |

`PRODUCTS_TAG_TAKEN` can no longer be raised here — products carry no tag.

### `PATCH /api/v1/products/:id` 🔒

Partial update — same fields as create **except** `groupCode`; unknown fields rejected. Set `collectionId`, `artistId` or `organizationId` to `null` to detach. → `200` with the updated product.

### `DELETE /api/v1/products/:id` 🔒

**Soft archive** — products are never hard-deleted, provenance depends on them. Sets `archivedAt`, `isActive = false` **and** `status = ARCHIVED`: the old single `state` column expressed this in one value, and leaving any of the three unset would keep the row visible to a query checking a different one. → `204` (no body).

> 🔒 Write routes currently require any authenticated user; role-based permissions (ADMIN) plug into these routes when roles expand beyond `USER`.

---

## Module error-code namespaces

Every module prefixes its codes, so a code always tells you where it came from:

| Prefix | Module |
|---|---|
| `AUTH_*` | auth |
| `USERS_*` | users |
| `PRODUCTS_*` | products |
| `COLLECTIONS_*` | collections |
| `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_ERROR`, … | shared |

(discover and marketplace define no error codes of their own — they only read, so shared codes cover them.)
