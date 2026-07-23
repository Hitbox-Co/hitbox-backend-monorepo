# HitBox Backend — API Reference

Base URL (local): `http://localhost:8080`
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
| `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_ERROR`, … | shared |
