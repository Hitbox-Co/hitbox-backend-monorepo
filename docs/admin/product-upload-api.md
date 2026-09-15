# Product Upload & Images API

> Creating a drop, what the request body may actually look like, and managing
> its image gallery.
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
[admin-write-apis.md §0](admin-write-apis.md).

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
| `images[]` | ≤24 entries | no | attaches uploaded assets as the gallery |

Everything in `skus` and `images` is written in the **same transaction** as the
product. The request either produces a complete drop — catalog row, units,
gallery — or produces nothing.

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

**Asset ids are validated before the product is written.** A typo'd uuid fails
the request without creating anything, so the whole payload does not have to be
resubmitted to fix one id.

---

## 3. Images

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

## 4. Errors

| HTTP | `code` | Raised when |
|---|---|---|
| `400` | `BODY_REQUIRED` | no JSON body was parsed — check `Content-Type` |
| `400` | `PRODUCTS_MINTING_UNAVAILABLE` | `skus` sent but no minting provider wired in |
| `400` | `PRODUCTS_SUPPLY_EXCEEDED` | `skus.count` > `totalSupply` in the same payload |
| `400` | `PRODUCTS_MEDIA_UNAVAILABLE` | `images` sent on a deploy with no bucket configured |
| `400` | `PRODUCTS_IMAGE_ASSET_INVALID` | asset missing, archived, or not a `DROP_IMAGE` |
| `403` | `AUTHZ_FORBIDDEN` | grant is organization-scoped, not `:global` |
| `404` | `PRODUCTS_NOT_FOUND` | no such drop |
| `404` | `PRODUCTS_IMAGE_NOT_FOUND` | no such placement on this drop |
| `409` | `PRODUCTS_IMAGE_DUPLICATE` | asset already in this gallery |
| `409` | `PRODUCTS_CODE_TAKEN` | five consecutive `groupCode` collisions |
| `422` | `VALIDATION_ERROR` | schema failure — see §1 |

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

## 5. Checklist

- [ ] Send `Content-Type: application/json` — its absence is the `BODY_REQUIRED` case
- [ ] Upload assets with `assetType: "DROP_IMAGE"`; nothing else attaches
- [ ] Call `PUT .../images` after a drag-and-drop reorder, not N× `PATCH`
- [ ] Re-render the gallery from the response of every mutation — positions cascade
- [ ] Do not send `position` at all unless the user reordered; arrival order is respected
- [ ] Expect the primary flag to move on its own when you delete the primary image
- [ ] Read `details[].received` on a 422 before changing the payload by guesswork
