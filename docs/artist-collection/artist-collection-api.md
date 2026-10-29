# Artist collections API — artist dashboard

> Everything the artist dashboard needs to list, create, edit, reorder,
> delete and restore the signed-in artist's collections, and see the active
> drops inside them. Every change is audited ([README 6](README.md#6-audit-trail)). Background and rules:
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
| 3 | `GET /artist/collections/:collectionId` | One of mine, **with its active drops** |
| 4 | `PATCH /artist/collections/:collectionId` | Edit name, slug, description, visibility |
| 5 | `DELETE /artist/collections/:collectionId` | Delete (archive) |
| 5a | `POST /artist/collections/:collectionId/restore` | Undo a delete |
| 6 | `PUT /artist/collections/order` | Reorder all live collections |
| 7 | `POST /artist/collections/:collectionId/hero/upload-url` | Upload URL for a hero image |
| 8 | `PUT /artist/collections/:collectionId/hero` | Use the uploaded image |
| 9 | `DELETE /artist/collections/:collectionId/hero` | Remove the hero image |
| 10 | `GET /artist/collections/:collectionId/available-drops` | The **Add drops** picker: my active drops not already in this collection |
| 11 | `POST /artist/collections/:collectionId/drops` | Add drops (or move them from another of my collections) |
| 12 | `DELETE /artist/collections/:collectionId/drops/:dropId` | Take a drop out of this collection |

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
  "counts": { "drops": 4, "liveDrops": 4, "activeDrops": 2 },
  "createdAt": "2026-10-23T10:00:00.000Z",
  "updatedAt": "2026-10-23T10:00:00.000Z",
  "actions": { "canEdit": true, "canArchive": false, "archiveBlockedReason": "HAS_DROPS", "canRestore": false }
}
```

| Field | Meaning |
|---|---|
| `slug` | Public URL handle, unique across all artists |
| `position` | 0-based order on your page, among live collections |
| `isPublic` | On the storefront. New collections start `false` (draft) |
| `status` | `LIVE` or `ARCHIVED` |
| `counts.drops` | Every drop ever filed under it, retired ones included |
| `counts.liveDrops` | Drops not archived, **in any status** (drafts, in review, on sale…). While this is above 0 the collection can't be deleted |
| `counts.activeDrops` | Drops **you are shown**: on sale (`ACTIVE`, switched on, not archived) and yours. Can be lower than `liveDrops` — drafts and drops in review count toward blocking delete but aren't listed |
| `actions.canEdit` | `false` once archived |
| `actions.canArchive` | Whether **Delete** will work right now |
| `actions.archiveBlockedReason` | `HAS_DROPS` (remove your on-sale drops — 12; drafts and drops in review are moved by your brand team / HitBox), `ARCHIVED`, or `null` |
| `actions.canRestore` | `true` for a deleted collection — show **Restore** (5a) |

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

The collection plus `drops`: the drops in it that are **active and yours**,
newest first (at most 100). Archived collections are returned too. Someone
else's id is `404`.

```json
{
  "data": {
    "id": "8e02…",
    "name": "Kaze — Season One",
    "…": "…every collection field above…",
    "counts": { "drops": 4, "liveDrops": 4, "activeDrops": 2 },
    "drops": [
      {
        "id": "d1a0…",
        "publicCode": "drp0…",
        "name": "Kaze Genesis — Single Card",
        "groupCode": "1001-0001",
        "totalSupply": 500,
        "rewardPoints": 150,
        "publishedAt": "2026-09-10T12:00:00.000Z",
        "releaseStart": "2026-09-10T12:00:00.000Z",
        "releaseEnd": null
      }
    ]
  }
}
```

A drop appears here only when **all** of these hold:

- `status` is `ACTIVE`, it's switched on, and it isn't archived — the same
  rule the public catalog uses. Drafts, drops in review, approved but not yet
  live, ended and rejected drops are not listed;
- it's **your** drop (`artistId` is you). Drop managers can't put another
  artist's drop in your collection any more — products refuses it.

Only this route lists drops; the list (1) and every write return `counts` only.

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
    "message": "This collection still holds 4 drops (including any not yet on sale). Remove your on-sale drops from it first; drops not yet on sale (drafts, in review) are moved or retired by your brand team or HitBox.",
    "details": { "liveDrops": 4 }
  }
}
```

Response `200`: the collection, now `status: "ARCHIVED"`. Deleting it again
is `409 ARTIST_COLLECTION_ARCHIVED`. Undo it with **restore** (5a).

## 5a. `POST /artist/collections/:collectionId/restore`

Undoes a delete. Body optional:

```json
{}
```
or, when the old name has been taken by another of your collections since:
```json
{ "name": "Season One (2025)" }
```

The collection comes back **live**, **private** (`isPublic: false` — publish
it again with PATCH when you're ready), at the **end** of your list, with the
same slug.

| Error | When |
|---|---|
| `409 ARTIST_COLLECTION_NOT_ARCHIVED` | It isn't deleted (or was restored a moment ago) |
| `409 ARTIST_COLLECTION_NAME_TAKEN` | You have another live collection with that name — resend with `name` |
| `409 ARTIST_COLLECTION_LIMIT_REACHED` | You already have 50 live collections |

Response: the collection, `status: "LIVE"`.

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

## 10–12. Drops in a collection

> **Reward points.** Every drop shows `rewardPoints`, here and in 3. They're
> set by HitBox System Admin; the artist sees them but can't change them
> ([admin/drop-reward-points.md](../admin/drop-reward-points.md)).

An artist files **their own** drops into **their own** collections. Three
rules hold everywhere:

- **Yours only.** A drop is yours when its `artistId` is your artist
  profile. Someone else's drop is never listed, and adding one answers
  `NOT_FOUND` — the same as a drop that doesn't exist, so ids can't be probed.
- **Active only.** Only drops on sale can be added: `status: ACTIVE`,
  switched on, not archived — the same rule as the drops shown in a
  collection (3). Drafts, drops in review, approved-not-live, ended and
  rejected drops can't be added.
- **Not already there.** The picker never lists a drop that's already in this
  collection, and adding one again is refused.

A drop sits in at most one collection. Adding a drop that's in another of
your collections **moves** it — but only when you say so with `move: true`.

The collection must be live (not deleted) for all three.

### 10. `GET /artist/collections/:collectionId/available-drops`

| Query | Values |
|---|---|
| `includeFiled` | `false` (default): only drops in **no** collection. `true`: also drops in your **other** collections — each says where it is now |
| `q` | Case-insensitive match on the drop name, or a group code |
| `page`, `limit` | default 1, 20; `limit` ≤ 100 |

```json
{
  "page": 1,
  "limit": 20,
  "total": 2,
  "items": [
    {
      "id": "e001d2b4-…",
      "publicCode": "drp0…",
      "name": "Kaze Genesis — Single Card",
      "groupCode": "1001-0001",
      "totalSupply": 500,
      "rewardPoints": 150,
      "publishedAt": "2026-09-10T12:00:00.000Z",
      "currentCollection": null
    },
    {
      "id": "a7f1…",
      "name": "Kaze — Neon Nights Tour Tee",
      "…": "…",
      "currentCollection": { "id": "f80d…", "name": "Season One" }
    }
  ]
}
```

`currentCollection` is only ever non-null with `includeFiled=true` — show it
as "In *Season One* — adding moves it".

### 11. `POST /artist/collections/:collectionId/drops`

```json
{ "dropIds": ["e001d2b4-…", "a7f1…"], "move": false }
```

| Field | Rules |
|---|---|
| `dropIds` | 1–50 drop ids, no duplicates |
| `move` | Default `false`. `true` lets drops already in another of your collections move here |

**All or nothing.** Every drop is checked first and every problem is reported
together; nothing is added unless all of them can be:

```json
{
  "error": {
    "code": "ARTIST_COLLECTION_DROPS_INVALID",
    "message": "Some drops cannot be added to this collection.",
    "details": {
      "problems": [
        { "dropId": "5bb3…", "problem": "NOT_ACTIVE" },
        { "dropId": "e001…", "problem": "IN_ANOTHER_COLLECTION", "collection": { "id": "f80d…", "name": "Season One" } },
        { "dropId": "f7d7…", "problem": "NOT_FOUND" }
      ]
    }
  }
}
```

| `problem` | Meaning | What the UI should do |
|---|---|---|
| `NOT_FOUND` | No such drop, **or it isn't yours** | Drop it from the selection |
| `NOT_ACTIVE` | Not on sale (draft, in review, ended, switched off, archived) | Drop it — it can be added once it's live |
| `ALREADY_IN_COLLECTION` | Already in this collection | Drop it — nothing to do |
| `IN_ANOTHER_COLLECTION` | In another of your collections (`collection` says which) | Ask "Move it from *{collection.name}*?" and resend with `move: true` |

Response `200`:

```json
{
  "data": {
    "collection": { "…": "the collection detail, as in 3 — drops included" },
    "dropIds": ["e001d2b4-…", "a7f1…"],
    "movedFrom": { "a7f1…": "f80d…" }
  }
}
```

`movedFrom` maps each moved drop to the collection it left — refresh that one
too. If a drop changed between the check and the write (retired, reassigned,
moved by someone else) the whole request is refused with
`409 ARTIST_COLLECTION_DROPS_CHANGED` and nothing changes; reload the picker.

### 12. `DELETE /artist/collections/:collectionId/drops/:dropId`

No body. Takes the drop out of this collection — it isn't deleted or
unpublished, just no longer in any collection (it shows up again in the
picker, 10). Works for any of your drops in this collection, active or not.

Response `200`: same shape as 11, with `movedFrom: {}`. A drop that isn't in
this collection, or isn't yours, is `404 ARTIST_COLLECTION_DROP_NOT_IN_COLLECTION`.

Both 11 and 12 are audited (`artist.collection.drops.add` /
`.drops.remove`, [README 6](README.md#6-audit-trail)) and announced on the
bus (`artist.collection.drops-added` / `.drop-removed`).

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
| `409` | `ARTIST_COLLECTION_ARCHIVED` | Editing or deleting an archived collection — restore it first |
| `409` | `ARTIST_COLLECTION_NOT_ARCHIVED` | Restoring a collection that isn't deleted |
| `400` | `ARTIST_COLLECTION_DROPS_INVALID` | Adding drops: one or more can't be added — `details.problems[]` (11) |
| `400` | `ARTIST_COLLECTION_DROPS_UNAVAILABLE` | The drop catalog isn't wired on this server |
| `404` | `ARTIST_COLLECTION_DROP_NOT_IN_COLLECTION` | Removing a drop that isn't in this collection or isn't yours |
| `409` | `ARTIST_COLLECTION_DROPS_CHANGED` | A drop changed between check and write — nothing was changed; reload |
| `409` | `ARTIST_COLLECTION_HAS_DROPS` | Deleting a collection that still has live drops (`details.liveDrops`) |
| `409` | `ARTIST_COLLECTION_LIMIT_REACHED` | Already 50 live collections (`details.max`) |
| `409` | `ARTIST_PROFILE_LOCKED` | Your profile is archived or deactivated — read-only |
| `422` | `VALIDATION_ERROR` | Malformed body, or a field you can't set |

---

## Frontend checklist

**Collections page**
- [ ] `GET /artist/collections` → cards in `position` order: hero image, name, `counts.liveDrops` drops, a **Draft** chip when `isPublic` is `false`.
- [ ] Drag-and-drop reorder → `PUT /artist/collections/order` with the full id list; replace the list with the response. On `ORDER_MISMATCH`, reload.
- [ ] An **Archived** tab → `?status=archived`: read-only cards with a **Restore** button (`actions.canRestore`). On `NAME_TAKEN`, ask for a new name and resend with `{ name }`. Tell the artist it comes back as a draft.
- [ ] Hide **New collection** at 50 live collections, or show the `LIMIT_REACHED` message.

**Create / edit form**
- [ ] Name (required), description, "Show on my page" toggle (default off), optional slug with a preview of the generated one (`{handle}-{name}`).
- [ ] Inline errors for `NAME_TAKEN` / `SLUG_TAKEN`.
- [ ] Warn before changing the slug of a public collection: old links stop working.
- [ ] Hero image picker → steps 7–9; show the returned `heroImageUrl`.

**Delete**
- [ ] Enable only when `actions.canArchive`. When `archiveBlockedReason` is `HAS_DROPS`: "This collection still has {counts.liveDrops} drops." Offer **Remove** on each drop in the grid (12); if `liveDrops` > `activeDrops`, add "{liveDrops − activeDrops} not yet on sale — your brand team or HitBox can move those."
- [ ] Confirm dialog: "This removes the collection from your page. You can restore it later from Archived."

**Collection detail**
- [ ] Drops grid from `drops` (active and yours only). Show `counts.activeDrops` as "N on sale".
- [ ] When `counts.liveDrops` > `counts.activeDrops`: "{liveDrops − activeDrops} more drops are being prepared" — they're why Delete is blocked even if the grid looks short.

**Add drops**
- [ ] **Add drops** button on a live collection → picker from 10: search box (`q`), paging, multi-select. A "Show drops in my other collections" toggle → `includeFiled=true`, with an "In *{currentCollection.name}*" chip on those rows.
- [ ] Submit → 11 with the selected ids; `move: true` only if the artist confirmed moving the chipped ones.
- [ ] On `DROPS_INVALID`, mark each `problems[].dropId`; for `IN_ANOTHER_COLLECTION` offer "Move here" (resend with `move: true`). On `DROPS_CHANGED`, reload the picker.
- [ ] Replace the collection with `data.collection`; if `movedFrom` isn't empty, refetch those collections too.
- [ ] **Remove** on each drop in the collection grid → 12 (confirm: "It stays on sale, it just leaves this collection").

**Profile locked**
- [ ] On `ARTIST_PROFILE_LOCKED`, switch the whole section to read-only.
