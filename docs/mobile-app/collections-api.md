# Collections — API

The **My Collection** tab: the items a user owns, their stats, and the
public/private switch per item. It also serves the "showcase" block on another
user's profile.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/collections/me/stats` | required | Stats block: item count, collections started, progress |
| `GET` | `/collections/me` | required | My shelf, private items included |
| `PATCH` | `/collections/me/:skuId` | required | Make one of my items `PUBLIC` or `PRIVATE` |
| `GET` | `/collections/user/:userId` | optional | Another collector's showcase: `PUBLIC` items, and only if their profile is `PUBLIC` |

Base path: `/api/v1/collections`. Code: `packages/collections`.

There is **no "add to collection" endpoint**. Items reach the shelf only by an
NFC claim. See [claims-nfc-api.md](claims-nfc-api.md).

---

## Authentication

`/me` routes need the Clerk session JWT:

```http
Authorization: Bearer <clerk-session-token>
```

`GET /collections/user/:userId` is public. A token is optional: when it belongs
to the shelf's owner, they get their whole shelf. An invalid token is treated as
a guest. Auth error codes (401/403) are listed in [auth-api.md](auth-api.md).

---

## Shapes

### `CollectionItem`: one shelf row

One row is **one serialized unit** (a SKU), for example copy #14 of 500. A user
can own several units of the same drop, and each is its own row.

```jsonc
{
  "id": "5b0e2c9a-…",                   // shelf-row id (not used in any path)
  "visibility": "PRIVATE",              // "PUBLIC" | "PRIVATE"
  "acquiredAt": "2026-11-03T11:02:00.000Z", // when it reached the shelf (the claim)
  "sku": {
    "id": "c41d7f20-…",                 // use this in PATCH /collections/me/:skuId
    "skuCode": "HB-KAZE-001-000014",
    "serialNumber": 14,                 // "#14" — position in the edition
    "claimedStatus": "CLAIMED"          // "UNCLAIMED" | "CLAIMED" | "IN_TRANSFER" | "FLAGGED"
  },
  "product": {
    "id": "6f1c9e44-…",                 // drop id → GET /products/:id on tap
    "name": "Kaze Genesis — Single Card",
    "imageUrl": "https://cdn.example.com/drops/kaze-genesis.webp", // primary image; null if none
    "rarity": "RARE",                   // free-form string; null if not set
    "rewardPoints": 150                 // 0 when none set
  }
}
```

`rarity` is a free-form column. Format it for display (replace `_` with a space,
uppercase) and do not switch on it as an enum.

`imageUrl` is `null` when the drop has no image, or when the server has no
storage bucket configured.

### `CollectionStats`: the stats block

```jsonc
{
  "totalClaimedItems": 3,          // all my shelf rows
  "totalArtistCollections": 2,     // artist collections I own ≥ 1 item from
  "collectionProgress": {
    "owned": 3,                    // my items that belong to an artist collection
    "total": 20,                   // sum of maximumLimit of those collections
    "percentage": 15               // round(owned / total × 100), 0–100; 0 when total is 0
  }
}
```

---

## Endpoints

### `GET /api/v1/collections/me/stats`

No parameters.

```json
{
  "data": {
    "totalClaimedItems": 3,
    "totalArtistCollections": 2,
    "collectionProgress": { "owned": 3, "total": 20, "percentage": 15 }
  }
}
```

### `GET /api/v1/collections/me`

My shelf, newest `acquiredAt` first.

| Param | Type / values | Default |
|---|---|---|
| `visibility` | `PUBLIC` `PRIVATE` | none (both) |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ CollectionItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

`totalPages` is at least `1`, even when `total` is `0`.

### `PATCH /api/v1/collections/me/:skuId`

Change one item's visibility. `:skuId` is `item.sku.id`, **not** `item.id` and
not the product id.

Request body (unknown fields are rejected):

| Field | Type | Rules |
|---|---|---|
| `visibility` | string | required, `PUBLIC` or `PRIVATE` |

```json
{ "visibility": "PUBLIC" }
```

Response: the updated item.

```jsonc
{ "data": CollectionItem }
```

| Status | Code | When |
|---|---|---|
| 404 | `COLLECTIONS_ITEM_NOT_FOUND` | You have no shelf row for this SKU |
| 422 | `VALIDATION_ERROR` | Missing or invalid `visibility`, or an extra field |
| 400 | `BODY_REQUIRED` | No JSON body parsed (missing `Content-Type: application/json`) |

### `GET /api/v1/collections/user/:userId`

Another collector's showcase. `:userId` is the account id (`id` from
[users-api.md](users-api.md)).

| Who is asking | Result |
|---|---|
| Anyone, the owner's **profile is `PUBLIC`** | 200: the items they marked `PUBLIC` |
| Anyone, the owner's **profile is `PRIVATE`** | **403 `COLLECTIONS_PROFILE_PRIVATE`**: no items at all |
| The owner themselves (valid token) | 200: their whole shelf, like `/collections/me` |

Check `isPrivate` on the profile (`GET /users/:id`) first, and skip this call for
private profiles. The item count is still shown there, in `stats.claimedItems`.

| Param | Type / values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |
| `visibility` | accepted but **ignored**; always `PUBLIC` | — |

```jsonc
{
  "data": [ CollectionItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 403 | `COLLECTIONS_PROFILE_PRIVATE` | `/user/:userId`: the collector's profile is private |
| 404 | `COLLECTIONS_USER_NOT_FOUND` | `/user/:userId`: no such collector (a malformed id included), or deactivated/deleted |
| 404 | `COLLECTIONS_ITEM_NOT_FOUND` | `PATCH /me/:skuId`: not on your shelf |

Bad query values (`limit=500`, `visibility=FRIENDS`) return
**422 `VALIDATION_ERROR`** with field details. Shared codes (`RATE_LIMITED`,
`INTERNAL_ERROR`) are in [../api-reference.md](../api-reference.md#conventions).

---

## How it works

### How an item gets on the shelf

1. The user taps an item's NFC tag and claims it
   ([claims-nfc-api.md](claims-nfc-api.md)).
2. The claim creates the shelf row in the same database transaction. Its
   `visibility` is what the claim request sent (default `PRIVATE`).
3. The row appears at the top of `GET /collections/me` straight away.

### Visibility

| Value | Who sees the item |
|---|---|
| `PRIVATE` (default) | Only the owner, in `/collections/me` |
| `PUBLIC` | Everyone, in `/collections/user/:userId`, **while the owner's profile is `PUBLIC`** |

This per-item setting sits under the **profile** setting
([users-api.md](users-api.md#public-and-private-profiles)). A private profile
hides every item, whatever each item says. Switching the profile back to public
restores the per-item choices.

Visibility also controls whether **other people** see you as the owner when
they scan your item. You are named only when the item **and** your profile are
`PUBLIC`. Otherwise it says "claimed by another collector". See
[Owner privacy](claims-nfc-api.md#owner-privacy).

### Removed items

When a claim is taken back (a refund or a lost dispute), the shelf row is
archived, not deleted. Archived rows are left out of every list and of the
stats. If the same user claims the unit again later, the old row comes back
with its old `visibility` and `acquiredAt`.

### Stats rules

- `totalClaimedItems` counts every live shelf row.
- An item counts towards progress only if its drop belongs to an **artist
  collection**. Items from drops with no collection count in
  `totalClaimedItems` only.
- `total` is the sum of each started collection's `maximumLimit` (how many
  pieces the collection holds; default 10). A collection counts once you own at
  least one item from it.
- Example: you own items in 3 collections whose limits add up to 25, and 10 of
  your items belong to them. Progress is 10 / 25 = **40%**.

### Item tap

`item.product.id` → `GET /api/v1/products/:id` (drop detail screen).

---

## Known limitations

- **Progress can pass the real count.** `owned` counts units, so two copies of
  the same drop count twice. `percentage` is capped at 100.
- **Malformed `:skuId` is not validated.** It is passed to the database as-is,
  so a value that is not a UUID gives a **500**, not a 404/422. (`:userId` is
  validated: a malformed one is a 404.)
- **`PATCH` also works on an archived row.** It does not check `archivedAt`,
  so it can change the visibility of an item that no longer shows on the shelf.
- **No genre filter.** It was removed with the schema; there is no replacement.
