# Artist collections API — artist dashboard

> Everything the artist dashboard needs to list, create, edit, reorder and
> delete the signed-in artist's collections. Background and rules:
> [README.md](README.md). Monitoring for HitBox staff:
> [admin-monitoring-api.md](admin-monitoring-api.md).

Base path **`/api/v1/artist`**, Clerk session required. The caller must hold
the ARTIST role (`brand-artist-record:read:own` / `update:own`); anyone else
gets `403 AUTHZ_FORBIDDEN`. There is no artist id anywhere in these paths —
it is always the signed-in artist.

| # | Method & path | What it does |
|---|---|---|
| 1 | `GET /artist/collections` | My collections, in display order |
| 2 | `POST /artist/collections` | Create one |
| 3 | `GET /artist/collections/:collectionId` | One of mine |
| 4 | `PATCH /artist/collections/:collectionId` | Edit name, slug, description, visibility |
| 5 | `DELETE /artist/collections/:collectionId` | Delete (archive) |
| 6 | `PUT /artist/collections/order` | Reorder all live collections |
| 7 | `POST /artist/collections/:collectionId/hero/upload-url` | Upload URL for a hero image |
| 8 | `PUT /artist/collections/:collectionId/hero` | Use the uploaded image |
| 9 | `DELETE /artist/collections/:collectionId/hero` | Remove the hero image |

---

## The collection object

Every route that returns a collection returns this shape (route 1 returns an
array of them).

```json
{
  "id": "5c1d…",
  "publicCode": "acl06851nknhswjp8cwkn4",
  "name": "Season Two",
  "slug": "kaze-season-two",
  "description": "Twelve pieces from the autumn tour.",
  "heroImageUrl": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/profile-images/artists/23ef…/a91f….png",
  "position": 1,
  "isPublic": false,
  "isActive": true,
  "archivedAt": null,
  "status": "LIVE",
  "counts": { "drops": 4, "liveDrops": 4 },
  "createdAt": "2026-10-23T10:00:00.000Z",
  "updatedAt": "2026-10-23T10:00:00.000Z",
  "actions": { "canEdit": true, "canArchive": false, "archiveBlockedReason": "HAS_DROPS" }
}
```

| Field | Meaning |
|---|---|
| `slug` | Public URL handle, unique across all artists |
| `position` | 0-based order on your page, among live collections |
| `isPublic` | On the storefront. New collections start `false` (draft) |
| `status` | `LIVE` or `ARCHIVED` |
| `counts.drops` | Every drop ever filed under it, retired ones included |
| `counts.liveDrops` | Drops not retired. While this is above 0 the collection can't be deleted |
| `actions.canEdit` | `false` once archived |
| `actions.canArchive` | Whether **Delete** will work right now |
| `actions.archiveBlockedReason` | `HAS_DROPS` (ask your brand team / HitBox to move or retire its drops), `ARCHIVED`, or `null` |

---

## 1. `GET /artist/collections`

| Query | Values |
|---|---|
| `status` | `live` (default), `archived`, `all` |

```json
{ "data": [ { …collection… }, { …collection… } ] }
```

Live collections come first in `position` order, archived ones after. Not
paginated — an artist has at most 50 live collections.

## 2. `POST /artist/collections`

```json
{ "name": "Season Two", "description": "Twelve pieces from the autumn tour.", "isPublic": false }
```

| Field | Rules |
|---|---|
| `name` | Required, 1–120 chars. Must not match one of your **live** collections (case-insensitive) |
| `slug` | Optional. 3–60 chars, lowercase letters, digits and single hyphens. Omit it and it's generated as `{your-handle}-{name}` (`kaze-season-two`), with `-2`, `-3`… if taken |
| `description` | Optional, up to 2000 chars |
| `isPublic` | Optional, default `false` |

Any other field (`artistId`, `organizationId`, `position`, `isActive`,
`heroImageUrl`, …) is refused with `422` naming it. The collection is yours,
belongs to your organization, and goes at the end of your list.

Response `201`: the collection.

## 3. `GET /artist/collections/:collectionId`

Response: the collection. Archived ones are returned too. Someone else's id
is `404`.

## 4. `PATCH /artist/collections/:collectionId`

Send only what changes — at least one of `name`, `slug`, `description`,
`isPublic`.

```json
{ "isPublic": true }
```

- Changing `name` doesn't change `slug` — old links keep working. Change
  `slug` explicitly if you want a new address (old links then break).
- `description: ""` or `null` clears it.
- Archived collections can't be edited (`409 ARTIST_COLLECTION_ARCHIVED`).

Response: the updated collection.

## 5. `DELETE /artist/collections/:collectionId`

No body. Archives the collection: it leaves the storefront
(`isPublic: false`), becomes read-only, and the rest of your list closes up
behind it. The name becomes free to reuse; the slug stays reserved.

Refused while it still holds drops that aren't retired:

```json
{
  "error": {
    "code": "ARTIST_COLLECTION_HAS_DROPS",
    "message": "This collection still holds 4 drops. Drops have to be moved to another collection or retired before it can be deleted — ask your brand team or HitBox to do that.",
    "details": { "liveDrops": 4 }
  }
}
```

Response `200`: the collection, now `status: "ARCHIVED"`. Deleting it again
is `409 ARTIST_COLLECTION_ARCHIVED`. There is no undo yet.

## 6. `PUT /artist/collections/order`

The **whole** live list, in the new order (drag-and-drop result):

```json
{ "collectionIds": ["5c1d…", "8e02…", "a771…"] }
```

Every live collection exactly once, no archived ones. Otherwise
`400 ARTIST_COLLECTION_ORDER_MISMATCH` with
`details: { "missing": [...], "unknown": [...] }` — reload the list and retry.

Response: `{ "data": [ …live collections in the new order… ] }`.

## 7–9. Hero image

Three steps, same as the profile cover:

1. `POST /artist/collections/:collectionId/hero/upload-url`
   ```json
   { "fileName": "hero.png", "mimeType": "image/png", "sizeBytes": 482113 }
   ```
   → `201 { "data": { "assetId", "uploadUrl", "expiresIn": 300, "publicUrl" } }`.
   JPEG, PNG, WebP or GIF, up to 15 MB; `sizeBytes` is the exact `file.size`.
2. `PUT` the file to `uploadUrl` with header `Content-Type` equal to `mimeType`.
3. `PUT /artist/collections/:collectionId/hero` with `{ "assetId": "…" }` →
   the collection with `heroImageUrl` set.

`DELETE /artist/collections/:collectionId/hero` clears it (the file is kept).

Step 3 refuses (`400 ARTIST_IMAGE_INVALID`) an image you didn't upload, a
non-image, a deleted one, or one that failed the virus scan. On a server
with no storage configured, step 1 returns `400 ARTIST_IMAGES_UNAVAILABLE`.

---

## Errors

| Status | Code | When |
|---|---|---|
| `400` | `ARTIST_COLLECTION_ORDER_MISMATCH` | Reorder list doesn't name every live collection exactly once |
| `400` | `ARTIST_IMAGE_INVALID` | Hero image can't be used (see 7–9) |
| `400` | `ARTIST_IMAGES_UNAVAILABLE` | No image storage on this server |
| `403` | `AUTHZ_FORBIDDEN` | Not signed in as an artist |
| `404` | `ARTIST_PROFILE_NOT_FOUND` | Your account isn't linked to an artist profile |
| `404` | `ARTIST_COLLECTION_NOT_FOUND` | No such collection of yours |
| `409` | `ARTIST_COLLECTION_NAME_TAKEN` | You already have a live collection with that name |
| `409` | `ARTIST_COLLECTION_SLUG_TAKEN` | That slug is used by another collection (any artist's) |
| `409` | `ARTIST_COLLECTION_ARCHIVED` | Editing or deleting an archived collection |
| `409` | `ARTIST_COLLECTION_HAS_DROPS` | Deleting a collection that still has live drops (`details.liveDrops`) |
| `409` | `ARTIST_COLLECTION_LIMIT_REACHED` | Already 50 live collections (`details.max`) |
| `409` | `ARTIST_PROFILE_LOCKED` | Your profile is archived or deactivated — read-only |
| `422` | `VALIDATION_ERROR` | Malformed body, or a field you can't set |

---

## Frontend checklist

**Collections page**
- [ ] `GET /artist/collections` → cards in `position` order: hero image, name, `counts.liveDrops` drops, a **Draft** chip when `isPublic` is `false`.
- [ ] Drag-and-drop reorder → `PUT /artist/collections/order` with the full id list; replace the list with the response. On `ORDER_MISMATCH`, reload.
- [ ] An **Archived** tab → `?status=archived` (read-only cards).
- [ ] Hide **New collection** at 50 live collections, or show the `LIMIT_REACHED` message.

**Create / edit form**
- [ ] Name (required), description, "Show on my page" toggle (default off), optional slug with a preview of the generated one (`{handle}-{name}`).
- [ ] Inline errors for `NAME_TAKEN` / `SLUG_TAKEN`.
- [ ] Warn before changing the slug of a public collection: old links stop working.
- [ ] Hero image picker → steps 7–9; show the returned `heroImageUrl`.

**Delete**
- [ ] Enable only when `actions.canArchive`. When `archiveBlockedReason` is `HAS_DROPS`: "This collection still has {counts.liveDrops} drops — ask your brand team or HitBox to move or retire them first."
- [ ] Confirm dialog: "This removes the collection from your page. It can't be undone."

**Profile locked**
- [ ] On `ARTIST_PROFILE_LOCKED`, switch the whole section to read-only.
