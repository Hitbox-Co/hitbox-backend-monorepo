# Mobile app — API docs

Every endpoint the HitBox buyer app calls, one file per area of the app.

Admin (`/api/v1/admin/*`), the artist portal (`/api/v1/artist/*`), the vendor
portal (`/api/v1/vendor/*`) and the public website (`/app/web/v1/*`) are separate
clients and are **not** covered here. For those, see [../api-reference.md](../api-reference.md)
and the folders under [../](../).

## Files

| File | Base path | App area |
|---|---|---|
| [auth-api.md](auth-api.md) | `/health`, `/auth`, `/authz` | Sign-up check, session, "who am I", own permissions |
| [users-api.md](users-api.md) | `/users` | Profile: view and edit your own, view others |
| [discover-api.md](discover-api.md) | `/discover` | Discover tab: hero, trending, creators, latest drops, search |
| [marketplace-api.md](marketplace-api.md) | `/marketplace` | Marketplace tab: search, category chips, Featured Listings, See All |
| [products-api.md](products-api.md) | `/products` | Drop detail screen (opened from any card) |
| [collections-api.md](collections-api.md) | `/collections` | My Collection tab: owned items, stats |
| [claims-nfc-api.md](claims-nfc-api.md) | `/claims`, `/claim`, `/verify`, `/ledger` | Scan tab: NFC tap → verify → claim ownership |
| [rewards-api.md](rewards-api.md) | `/rewards` | Exclusive content unlocked by owning drops |
| [orders-api.md](orders-api.md) | `/orders` | Checkout, order history, shipments (starts with the full purchase flow) |
| [payments-api.md](payments-api.md) | buyer payment routes | Paying for an order, refund requests |
| [invoices-api.md](invoices-api.md) | buyer invoice routes | Receipts / tax invoices |

## Base URL

```
http://localhost:<PORT>/api/v1      # local, PORT from the root .env
```

All paths in these docs are relative to `/api/v1` unless written in full.

## Authentication

The app signs users in with **Clerk** and sends the session JWT on every call
that needs a user:

```http
Authorization: Bearer <clerk-session-token>
```

Only the header works. The `__session` cookie is not read, because no cookie parser is installed.

Each endpoint is marked as one of:

| Mark | Meaning |
|---|---|
| **public** | No token needed. A token is ignored. |
| **optional** | Works without a token. With a valid token, the response is personalised, for example wishlist hearts on Discover. An invalid token is treated as a guest, not rejected. |
| **required** | No valid token → 401/403 (codes below). |

Errors from a **required** endpoint's auth check:

| Status | Code | When |
|---|---|---|
| 401 | `AUTH_UNAUTHENTICATED` | No token sent |
| 401 | `AUTH_INVALID_TOKEN` | Token invalid or expired, so refresh it with Clerk and retry |
| 401 | `AUTH_ACCOUNT_NOT_FOUND` | Valid token but no local account (the server tries to create one from Clerk first) or the account is deleted |
| 403 | `AUTH_ACCOUNT_SUSPENDED` | Account suspended |
| 403 | `AUTH_EMAIL_UNVERIFIED` | Primary email not verified. Defined, but never raised today (see [auth-api.md](auth-api.md)). |

Full details are in [auth-api.md](auth-api.md).

## Responses

```jsonc
// success
{ "data": { … } }                                   // one resource
{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }  // a page of a list

// error: always this shape
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": … } }
```

Money is sent as a **decimal string** (`"480.00"`), never a float. Ids are UUID strings.

## Errors

Shared by every endpoint:

| Status | Code | When |
|---|---|---|
| 400 | `BODY_REQUIRED` | A POST/PATCH with no JSON body was parsed. Send `Content-Type: application/json`. |
| 404 | `NOT_FOUND` | Unknown route or resource |
| 422 | `VALIDATION_ERROR` | A query parameter or body field failed validation |
| 429 | `RATE_LIMITED` | Too many requests (see below) |
| 500 | `INTERNAL_ERROR` | Server bug, safe to report |

A validation error lists each bad field:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "path": "limit", "message": "Number must be less than or equal to 50", "code": "too_big" }
    ]
  }
}
```

For **body** fields, each entry also has `receivedType` and `received` (the first
60 characters of the value sent), so you can see what arrived.

Module-specific codes are listed in each file.

## Rate limiting

Every `/api/v1/*` call is limited **per IP** to **100 requests per 60 seconds** by
default (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Request 101 inside a window
gets **429 `RATE_LIMITED`**. Every response carries the budget:

```http
RateLimit-Limit: 100
RateLimit-Remaining: 99
RateLimit-Reset: 60        # seconds until the window resets
```

On a 429, wait `RateLimit-Reset` seconds before retrying.

## Naming

The database calls a product a **Drop** (`Drop`, `DropVariant`, `DropPrice`,
`DropImage`). The routes still say `products`. A "drop", a "product" and a
"card id" in these docs are the same thing: the `Drop.id` UUID. One physical
unit of a drop is a **SKU**, which carries a serial number and an NFC tag.
