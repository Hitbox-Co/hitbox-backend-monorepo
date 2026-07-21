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
| 500 | `INTERNAL_ERROR` |

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

### `GET /api/v1/auth/me` 🔒

The authenticated principal (contents of `req.auth`).

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
    "username": "ayan",
    "firstName": "Ayan",
    "lastName": "Saha",
    "avatarUrl": "https://img.clerk.com/…",
    "createdAt": "2026-07-16T04:41:00.000Z",
    "email": "ayan@example.com",
    "role": "USER",
    "state": "ACTIVE",
    "rewardPoints": 0
  }
}
```

### `PATCH /api/v1/users/me` 🔒

Update own profile. All fields optional; unknown fields rejected.

```jsonc
// body
{
  "username": "ayan_2",        // 3–50 chars, letters/numbers/_/.
  "firstName": "Ayan",         // ≤100 chars
  "lastName": "Saha",          // ≤100 chars
  "avatarUrl": "https://…"     // valid URL
}
```

→ `200` with the updated `MeDto` (same shape as `GET /users/me`).

| Status | Code | When |
|---|---|---|
| 409 | `USERS_USERNAME_TAKEN` | username already in use |

### `GET /api/v1/users/:id`

Public profile (no email/role/points; soft-deleted users are 404).

```json
{ "data": { "id": "…", "username": "…", "firstName": "…", "lastName": "…", "avatarUrl": "…", "createdAt": "…" } }
```

| Status | Code |
|---|---|
| 404 | `USERS_NOT_FOUND` |

---

## Discover Module — `/api/v1/discover`

Read-side feed for the mobile **Discover** screen. Public (no auth). Items are deliberately **lightweight cards** — id, title, one image, reward points — not full product details; the client fetches `GET /products/:id` when a card is opened.

```jsonc
// DiscoverProductItem — the only shape this module returns
{
  "id": "cmro…",
  "name": "Pierce The Veil — Signature Series",
  "imageUrl": "https://…",        // first product image, null if none
  "rewardPoints": 12500
}
```

Sections map to the marketplace status a product carries:

| `section` value | Backing status | Ordering |
|---|---|---|
| `trending` | `TRENDING_NOW` | `unitsSold` desc |
| `new_releases` | `NEW_RELEASE` | `createdAt` desc |
| `top_creators` | `TOP_CREATORS` | `unitsSold` desc |

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
  "artistName": "Blink-182",        // via the product's collection, null if none
  "priceInDollars": "89.99",        // decimal serialized as string
  "rewardPoints": 4500,
  "badge": "HOT"                    // "HOT" | "NEW" | null (see below)
}
```

Badges derive from the product's curation status: `TRENDING_NOW` → `HOT`, `NEW_RELEASE` → `NEW`, anything else → `null`.

Category tabs are screen-level values that map to one or more product categories:

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

- `featured` — curated products (any marketplace status), most-sold first.
- `newListings` — newest active products.

> Bids, countdowns and **live auctions** belong to the P2P trading feature — they need their own models (listings, bids, escrow) and will extend this feed when that lands. Until then the client renders cards without the bid row.

### `GET /api/v1/marketplace/listings`

Paginated listings behind the **category tabs**, **search bar** and **"See All"**.

| Param | Type / values | Default |
|---|---|---|
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | — ("All Items") |
| `search` | 1–100 chars, case-insensitive name match | — |
| `sort` | `newest` `price_asc` `price_desc` `popular` | `newest` |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

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

which returns the full product (description, all images, `collection.artist`, rarity, claim status) — see the Products module below.

---

## Collections Module — `/api/v1/collections`

Backs the mobile **Collections** tab — a user's shelf of owned/claimed collectibles (`BuyerCollection`). Every item carries a per-item **visibility**: `PRIVATE` (default, owner-only) or `PUBLIC` (shown on the user's showcase).

Items enter a collection through the **claims flow** (NFC claim → collection entry) — there is deliberately no "add to collection" endpoint.

```jsonc
// CollectionItemDto — collection row + embedded product card
{
  "id": "cmro…",                    // collection-item id
  "visibility": "PUBLIC",           // "PUBLIC" | "PRIVATE"
  "totalClaimedNo": 1,
  "genre": "MUSIC",                 // nullable
  "addedAt": "2026-07-17T06:33:06.201Z",
  "product": {
    "id": "cmro…",                  // → GET /products/:id for full details
    "name": "Pierce The Veil — Signature Series Poster",
    "imageUrl": "https://…",        // first product image, null if none
    "rarity": "LEGENDARY",
    "rewardPoints": 12500,
    "claimedStatus": "CLAIMED"
  }
}
```

### `GET /api/v1/collections/me/stats` 🔒

Aggregated **stats section** for the authenticated user's Collections screen. All numbers are computed by aggregation over the live rows — the stored `BuyerCollection.totalClaimedNo` counter is intentionally **not** used.

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
| `totalClaimedItems` | Count of the user's collection items (rows), via aggregation. |
| `totalArtistCollections` | Distinct `ArtistCollection`s the user has **≥ 1** product from. |
| `collectionProgress.owned` | The user's items that belong to an `ArtistCollection`. |
| `collectionProgress.total` | Σ `maximumLimit` of those collections (see below). |
| `collectionProgress.percentage` | `round(owned / total × 100)`, clamped `0–100` (`0` when `total` is 0). |

**Collection Progress** measures how far the user is toward completing the collections they've started. Each `ArtistCollection` has a `maximumLimit` (how many collectibles it holds, **default 10**). If the user owns items across collections whose caps sum to `25` and they hold `10` of them, progress is `10 / 25 = 40%`.

> A collection only counts toward `totalArtistCollections` / progress once the user holds at least one product from it. Products not tied to any `ArtistCollection` count in `totalClaimedItems` but not in progress.

### `GET /api/v1/collections/me` 🔒

The authenticated user's own shelf — private items included. Newest first.

| Param | Type / values | Default |
|---|---|---|
| `genre` | `MUSIC` `SPORTS` `FILM` `GAMING` `PUBLICATION` `ART` `ANIME` `OTHER` | — |
| `visibility` | `PUBLIC` `PRIVATE` | — (both) |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```json
{
  "data": [ CollectionItemDto, … ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

### `PATCH /api/v1/collections/me/:productId` 🔒

Toggle one owned item between showcase and private. `:productId` is the **product's** id (not the collection-item id).

```jsonc
// body
{ "visibility": "PUBLIC" }   // or "PRIVATE"
```

→ `200` with the updated `CollectionItemDto`.

| Status | Code | When |
|---|---|---|
| 404 | `COLLECTIONS_ITEM_NOT_FOUND` | the product is not in *your* collection |

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

Public catalog listing — filtered, sorted, paginated. Only `ACTIVE` products.

Query parameters (all optional):

| Param | Type / values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–100 | `20` |
| `category` | `TRADING_CARD` `FIGURE` `POSTER` `BOOK` `AUTOGRAPH` `JERSEY` `DIGITAL_ASSET` `ACCESSORY` `GAME_BOX` `CARD_PACK` `OTHER` | — |
| `genre` | `MUSIC` `SPORTS` `FILM` `GAMING` `PUBLICATION` `ART` `ANIME` `OTHER` | — |
| `type` | `GROUP` `INDIVIDUAL` | — |
| `rarity` | `COMMON` `UNCOMMON` `RARE` `EPIC` `LEGENDARY` `EXCLUSIVE` | — |
| `marketplaceStatus` | `TRENDING_NOW` `NEW_RELEASE` `TOP_CREATORS` | — |
| `collectionId` | string | — |
| `search` | 1–100 chars, case-insensitive name match | — |
| `sort` | `newest` `price_asc` `price_desc` `popular` | `newest` |

```json
{
  "data": [ { "id": "…", "productCode": "123456780000", "name": "…", "images": [ … ], "collection": { "artist": { … } }, … } ],
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

### `GET /api/v1/products/:id`
### `GET /api/v1/products/code/:productCode`

Single product (includes `images` and `collection.artist`). → 404 `PRODUCTS_NOT_FOUND`.

### `POST /api/v1/products` 🔒

Create a product. The 12-digit `productCode` is **generated server-side**: 8 random digits + the 4-digit `groupCode`.

```jsonc
// body
{
  "name": "Signed Tour Poster",           // required, 1–255
  "type": "INDIVIDUAL",                   // required
  "category": "POSTER",                   // required
  "genre": "MUSIC",                       // required
  "description": "…",
  "rewardPoints": 100,                    // int ≥ 0, default 0
  "rarity": "RARE",                       // default COMMON
  "priceInDollars": 149.99,               // ≥ 0, default 0
  "inventoryUnit": 25,                    // int ≥ 0, default 0
  "marketplaceStatus": "NEW_RELEASE",
  "collectionId": "cmd0…",                // links to an ArtistCollection
  "tagId": "nfc-abc-123",                 // NFC tag, unique, ≤64
  "releaseDate": "2026-08-01",
  "groupCode": "0042",                    // exactly 4 digits, default "0000"
  "images": [ { "url": "https://…", "title": "front", "description": "…" } ]   // ≤10
}
```

→ `201` with the created product.

| Status | Code | When |
|---|---|---|
| 409 | `PRODUCTS_TAG_TAKEN` | `tagId` already assigned |
| 409 | `PRODUCTS_CODE_TAKEN` | could not allocate a unique code (after retries) |

### `PATCH /api/v1/products/:id` 🔒

Partial update — same fields as create **except** `groupCode` and `images`; unknown fields rejected. Set `collectionId: null` to detach from a collection. → `200` with the updated product.

### `DELETE /api/v1/products/:id` 🔒

**Soft archive** (sets `state = INACTIVE`) — products are never hard-deleted, provenance depends on them. → `204` (no body).

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
