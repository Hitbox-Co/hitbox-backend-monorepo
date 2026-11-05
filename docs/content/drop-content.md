# Drop content: regular and SKU-exclusive

> **Exclusive content at SKU level.** A drop has many units (SKUs), say 100. The
> artist can attach **regular content** that every owner of the drop opens,
> and **exclusive content** that only the owners of specific units open. For
> example, unit #001 might come with a signed poster video that #002–#100
> don't get.
>
> - Artist panel: `/api/v1/artist/drops/:dropId/content` (3)
> - Buyer app: `/api/v1/rewards/drops/:dropId` and `/api/v1/rewards/units/:skuId` (4)
>
> The files are the same kinds as [collection rewards](collection-rewards.md):
> video, music, GIFs and images, behind private, signed links.

---

## Contents

1. [The rule](#1-the-rule)
2. [How it fits together](#2-how-it-fits-together)
3. [Artist panel API](#3-artist-panel-api)
4. [Buyer API](#4-buyer-api)
5. [Files: types, sizes, links](#5-files-types-sizes-links)
6. [Audit trail and events](#6-audit-trail-and-events)
7. [Errors](#7-errors)
8. [Setup](#8-setup)
9. [Frontend checklists](#9-frontend-checklists)
10. [Code map](#10-code-map)

---

## 1. The rule

A drop's content comes in **tiers**:

| Tier | How many per drop | Who opens it |
|---|---|---|
| `REGULAR` | At most **1** | The owner of **any** unit of the drop |
| `EXCLUSIVE` | Up to **10** | Only the owner of a unit whose **serial number** the tier lists |

| Term | Meaning |
|---|---|
| **Unit / SKU** | One serialized item of the drop, `#001 of 100`. Serial numbers run `1…totalSupply`. |
| **Owns** | Owns the unit **now** and has **claimed** it (NFC tap, so it's on their shelf). Paid but not claimed doesn't count. |
| **Serial number** | How a tier names its units. A serial is the unit's printed identity and exists before the unit is minted, so the artist can set up exclusive content before any unit is made. |

**Exclusive content comes on top of regular content.** The owner of #001 sees
the regular tier and #001's exclusive tier. The owner of #002 sees the regular
tier, plus a locked teaser of the exclusive one.

**Access is decided live, every time**, from who owns the unit right now.
Nothing is granted and nothing has to be revoked:

| What happens | Result |
|---|---|
| The unit is resold or transferred | The new owner opens it. The old owner no longer does. |
| A claim is taken back (refund, lost dispute) | Access ends as soon as the buyer no longer owns the unit. |
| The artist changes a tier's serial list | Owners of units taken off lose access at once. Owners of units added get it at once. |
| The artist switches a tier off or removes it | Nobody opens it. It's hidden from buyers. |

One unit can be listed in more than one exclusive tier.

---

## 2. How it fits together

```
Artist panel ──► artist module ──(IDropContent)──► content module ──► ContentBundle (+ ContentBundleSerial)
                 proves the drop is                owns tiers, serials,       │
                 the caller's (Drop.artistId)      files, access              └─ files: media module
                                                                                 (EXCLUSIVE_CONTENT,
Buyer app ─────────────────────────────────────► content module                  private prefix)
                                                  reads Sku.ownerId (claimed)
```

- **Storage.** A tier is a `ContentBundle` on the drop (`productId`).
  `REGULAR` is `accessType = OWNER_ONLY`; `EXCLUSIVE` is `SKU_EXCLUSIVE`. An
  exclusive tier's units are rows of `ContentBundleSerial (bundleId, serialNumber)`.
  A partial unique index allows one `OWNER_ONLY` bundle per drop.
- **Ownership** comes from `Sku` (`ownerId`, `claimedStatus = CLAIMED`). It's
  read-only, the same shortcut collection rewards take.
- **Opening** is recorded in `ContentUnlock` with the unit's `skuId`. This is
  **telemetry only** (the artist's "opened by" figure), never access control.

---

## 3. Artist panel API

Base: `/api/v1/artist/drops/:dropId/content`. You need to be signed in as the
artist, with the same `brand-artist-record:*:own` grants as `/artist/me`:
reads use `brand-artist-record:read`, changes use `brand-artist-record:update`.

- **Ownership.** The drop must be one of yours (`Drop.artistId`). Anyone
  else's drop, or one that doesn't exist, is `404 ARTIST_DROP_NOT_FOUND`.
- **Locked profile.** A deactivated or archived artist profile can read but
  not change anything (`409 ARTIST_PROFILE_LOCKED`).

| Method | Path | What |
|---|---|---|
| `GET` | `…/content` | Everything on the drop: regular, exclusive tiers and limits |
| `POST` | `…/content` | Create a tier |
| `GET` | `…/content/:bundleId` | One tier |
| `PATCH` | `…/content/:bundleId` | Edit: name, description, on/off, serial list |
| `DELETE` | `…/content/:bundleId` | Remove (kept, so it can be restored) |
| `POST` | `…/content/:bundleId/restore` | Bring a removed tier back |
| `POST` | `…/content/:bundleId/items/upload-url` | File, step 1: get an upload URL |
| `POST` | `…/content/:bundleId/items` | File, step 2: add the uploaded file |
| `PUT` | `…/content/:bundleId/items/order` | Reorder files |
| `PATCH` | `…/content/:bundleId/items/:itemId` | Rename a file |
| `DELETE` | `…/content/:bundleId/items/:itemId` | Take a file out |

Every response is `{ data: … }`. Each tier comes back as this view:

| Field | Meaning |
|---|---|
| `id`, `publicCode` | The tier (`ContentBundle`) id |
| `dropId` | The drop |
| `tier` | `REGULAR` or `EXCLUSIVE` |
| `name`, `description` | Shown to buyers |
| `status` | `ON`: owners open it. `OFF`: paused, hidden from buyers. `REMOVED`: deleted; restore it. |
| `isActive`, `archivedAt` | The raw flags behind `status` |
| `serialNumbers` | `EXCLUSIVE`: the units that open it, ascending. `REGULAR`: always `[]`. |
| `items` | The files, in order, each with a signed `url` so you can preview them (see 5) |
| `itemCounts` | `{ VIDEO, AUDIO, GIF, IMAGE }` |
| `holders` | Buyers who own a unit that opens it right now |
| `openedBy` | Buyers who have opened it at least once |
| `moderation` | `{ locked, reason, lockedAt }`. While `locked`, you can't switch it on or restore it (`409 CONTENT_REWARD_MODERATION_LOCKED`). |
| `createdAt`, `updatedAt` | ISO timestamps |

### 3.1 `GET …/content`

```json
{
  "data": {
    "drop": { "id": "…", "publicCode": "drp…", "name": "Kaze Tee", "totalSupply": 100 },
    "regular": { "id": "…", "tier": "REGULAR", "status": "ON", "serialNumbers": [], "holders": 84, "…": "…" },
    "exclusive": [
      { "id": "…", "tier": "EXCLUSIVE", "name": "Signed poster", "serialNumbers": [1], "holders": 1, "…": "…" }
    ],
    "limits": { "maxExclusiveTiers": 10, "maxSerialsPerTier": 1000, "maxItemsPerTier": 20 }
  }
}
```

`regular` is `null` when the drop has none yet. Removed tiers are included, with
`status: "REMOVED"`.

### 3.2 `POST …/content`: create a tier

```json
{ "tier": "EXCLUSIVE", "name": "Signed poster", "description": "Only for #001", "serialNumbers": [1] }
```

| Field | Rules |
|---|---|
| `tier` | `REGULAR` or `EXCLUSIVE`, required |
| `name` | 1–120 characters, required |
| `description` | Up to 2000 characters, optional. `""` or `null` clears it. |
| `isActive` | Optional, default `true`. Send `false` to keep it hidden while you add files. |
| `serialNumbers` | `EXCLUSIVE`: required, 1–1000 positive integers, each within `1…totalSupply`. Duplicates are dropped and the list is sorted. `REGULAR`: must be left out. |

Answers `201` with the tier.

| Refusal | When |
|---|---|
| `409 DROP_CONTENT_REGULAR_EXISTS` | The drop already has a regular tier, possibly removed. `details.bundleId` points to it: edit or restore that one. |
| `409 DROP_CONTENT_TOO_MANY_TIERS` | The drop already has 10 exclusive tiers. Removed ones count, so restore and reuse one instead. |
| `400 DROP_CONTENT_SERIALS_INVALID` | The serial list is missing, out of range (`details.invalid`, `details.totalSupply`), too long, or was sent for `REGULAR` |

### 3.3 `PATCH …/content/:bundleId`

Any subset of `name`, `description`, `isActive`, `serialNumbers`; at least one
is required. `serialNumbers` (`EXCLUSIVE` only) **replaces the whole list** and
can't be empty: remove the tier instead. Access moves at once (see 1).

- A removed tier is `409 DROP_CONTENT_ARCHIVED`: restore it first.
- If HitBox locked the tier, switching it back on (`isActive: true`) is
  `409 CONTENT_REWARD_MODERATION_LOCKED`.

### 3.4 `DELETE …/content/:bundleId` and `POST …/restore`

`DELETE` removes the tier. Nobody opens it, and it's kept with its files and
serial list. Removing a tier that's already removed changes nothing.

`POST …/restore` brings it back as it was:

- A tier that isn't removed is `409 DROP_CONTENT_NOT_ARCHIVED`.
- If HitBox locked the tier, restoring it is `409 CONTENT_REWARD_MODERATION_LOCKED`.

### 3.5 Files

Adding a file takes two steps, the same as [collection rewards 3.4–3.8](collection-rewards.md#34-post-rewarditemsupload-url-step-1):

1. Call `POST …/content/:bundleId/items/upload-url` with
   `{ "fileName": "poster.mp4", "mimeType": "video/mp4", "sizeBytes": 12345678 }`.
   It answers `201` with `{ assetId, uploadUrl, expiresIn, requiredHeaders, kind }`.
2. `PUT` the bytes to `uploadUrl`, sending exactly `requiredHeaders`.
3. Call `POST …/content/:bundleId/items` with `{ "assetId": "…", "title": "Signing session" }`.
   `title` is optional. It answers `201` with the tier.

Any file uploaded for **this drop** can go into any of its tiers. A file
uploaded for another drop, or for a collection, is
`400 CONTENT_REWARD_FILE_INVALID`.

The other file routes:

| Route | Body | Notes |
|---|---|---|
| `PUT …/items/order` | `{ "itemIds": [ … ] }` | Must list every item of the tier exactly once |
| `PATCH …/items/:itemId` | `{ "title": … }` | `null` or `""` falls back to the file name |
| `DELETE …/items/:itemId` | none | Takes the file out of the tier. The file itself is kept. |

Each file route answers with the tier.

---

## 4. Buyer API

You need to be signed in as a buyer (`content-unlock:read:own`, held by
`BUYER_COLLECTOR`).

### 4.1 `GET /api/v1/rewards/drops/:dropId`

The drop's content, worked out for **every unit of it you own**.

- **Non-owners** can look at a released drop. Every tier is a locked teaser,
  which is good for a "#001 comes with exclusive content" badge on the drop
  page.
- **Unreleased or removed drop.** If you don't own a unit of it, it's
  `404 DROP_CONTENT_DROP_NOT_FOUND`.

```json
{
  "data": {
    "drop": { "id": "…", "publicCode": "drp…", "name": "Kaze Tee", "totalSupply": 100 },
    "myUnits": [{ "skuId": "…", "publicCode": "sku…", "serialNumber": 2 }],
    "content": [
      {
        "id": "…", "tier": "REGULAR", "name": "Making-of", "description": null,
        "itemCounts": { "VIDEO": 1, "AUDIO": 0, "GIF": 0, "IMAGE": 0 }, "itemTotal": 1,
        "eligibleSerials": [], "unlocked": true,
        "unlockedBy": [{ "skuId": "…", "publicCode": "sku…", "serialNumber": 2 }],
        "items": [{ "id": "…", "kind": "VIDEO", "title": "Making-of", "url": "https://…", "expiresIn": 3600, "…": "…" }]
      },
      {
        "id": "…", "tier": "EXCLUSIVE", "name": "Signed poster",
        "itemCounts": { "VIDEO": 0, "AUDIO": 0, "GIF": 0, "IMAGE": 1 }, "itemTotal": 1,
        "eligibleSerials": [1], "unlocked": false, "unlockedBy": [], "items": []
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `myUnits` | Your claimed units of this drop. It's `[]` if you own none. |
| `content` | Switched-on tiers only: regular first, then exclusive |
| `eligibleSerials` | `EXCLUSIVE`: the units that open it, so the app can say "Exclusive to #001". `REGULAR`: `[]`. |
| `unlocked` | One of your units opens it. When `false`, `items` is `[]` and no link is issued. |
| `unlockedBy` | Which of your units open it |
| `items` | Files with signed links (see 5) |

### 4.2 `GET /api/v1/rewards/units/:skuId`

The same shape, worked out for **one unit you own**: the drop's regular tier,
plus each exclusive tier that lists this unit's serial number. Use it on an
item's own screen on the buyer's shelf.

A unit that isn't yours, isn't claimed, or doesn't exist is
`404 DROP_CONTENT_UNIT_NOT_FOUND`.

---

## 5. Files: types, sizes, links

These are the same rules as [collection rewards 5](collection-rewards.md#5-files-types-sizes-links).

| Kind | MIME types | Max size |
|---|---|---|
| `VIDEO` | `video/mp4`, `video/webm`, `video/quicktime` | 500 MB |
| `AUDIO` | `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/flac` | 100 MB |
| `GIF` | `image/gif` | 50 MB |
| `IMAGE` | `image/jpeg`, `image/png`, `image/webp` | 25 MB |

- **Limit.** A tier holds up to 20 files.
- **Storage.** Files are stored under the private prefix
  `exclusive-content/products/{dropId}/…`.
- **Links.** A `url` is a signed GET that lasts `expiresIn` seconds (an hour).
  It's issued only to the drop's artist or to a buyer whose unit opens the
  tier. Don't cache it past `expiresIn`: call the endpoint again for fresh
  links. A file that was deleted or failed the virus scan keeps its place with
  `url: null`.

---

## 6. Audit trail and events

Every change the artist makes is audited. The actor type is `ARTIST`, the
resource is `ContentBundle`, and each record has before/after snapshots. The
snapshot includes `serialCount` and up to 100 `serialNumbers`.

| Event | Severity | When |
|---|---|---|
| `artist.drop.content.save` | INFO | Created, edited, switched on/off or restored. `metadata.action` is `create`, `update` or `restore`. `metadata.tier` is the tier. On an edit, `metadata.serialsAdded` and `metadata.serialsRemoved` list the units that gained or lost access. |
| `artist.drop.content.remove` | WARNING | Removed: owners can no longer open it |
| `artist.drop.content.item.add` | INFO | A file was added (`metadata.kind`, `itemId`, `assetId`) |
| `artist.drop.content.item.update` | INFO | Files renamed or reordered (`metadata.action`) |
| `artist.drop.content.item.remove` | INFO | A file was taken out |

Domain events (in-process bus):

| Event | Payload |
|---|---|
| `artist.drop.content-changed` | `{ dropId, artistId, bundleId, tier, status, itemCount }` |
| `content.drop-content.opened` | `{ bundleId, dropId, tier, userId, skuId, serialNumber }`. Published the first time a buyer opens a tier with a given unit. |

---

## 7. Errors

| Status | Code | When |
|---|---|---|
| `404` | `ARTIST_DROP_NOT_FOUND` | Not your drop, or no such drop (artist panel) |
| `404` | `DROP_CONTENT_NOT_FOUND` | No such tier on this drop |
| `404` | `DROP_CONTENT_DROP_NOT_FOUND` | Drop missing, or not released and you own no unit of it (buyer) |
| `404` | `DROP_CONTENT_UNIT_NOT_FOUND` | Not your claimed unit (buyer) |
| `409` | `DROP_CONTENT_REGULAR_EXISTS` | The drop already has a regular tier. `details.bundleId` points to it. |
| `409` | `DROP_CONTENT_TOO_MANY_TIERS` | 10 exclusive tiers already |
| `409` | `DROP_CONTENT_ARCHIVED` | The tier is removed. Restore it first. |
| `409` | `DROP_CONTENT_NOT_ARCHIVED` | Restore asked for a tier that isn't removed |
| `409` | `CONTENT_REWARD_MODERATION_LOCKED` | HitBox locked it. `details.reason` says why. |
| `409` | `CONTENT_REWARD_TOO_MANY_ITEMS` | The tier already has 20 files |
| `409` | `CONTENT_REWARD_FILE_DUPLICATE` | The file is already in this tier |
| `409` | `ARTIST_PROFILE_LOCKED` | Your artist profile is deactivated or archived |
| `400` | `DROP_CONTENT_SERIALS_INVALID` | Bad serial list (see 3.2) |
| `400` | `CONTENT_REWARD_FILE_TYPE` | Not a video, music track, GIF or image, or too big |
| `400` | `CONTENT_REWARD_FILE_INVALID` | The file is missing, wasn't uploaded for this drop, is deleted or infected, or hasn't finished uploading |
| `400` | `CONTENT_REWARD_ORDER_MISMATCH` | The reorder list isn't exactly the tier's items |
| `400` | `CONTENT_REWARD_MEDIA_UNAVAILABLE` | No storage bucket on this server |
| `400` | `ARTIST_DROP_CONTENT_UNAVAILABLE` / `ARTIST_DROP_CATALOG_UNAVAILABLE` | The content module or the drop catalog isn't wired on this server |
| `400` | `VALIDATION_ERROR` | The body doesn't match the schema, for example unknown fields or `tier: "GOLD"` |

---

## 8. Setup

Per environment:

```bash
pnpm --filter @hitbox/database db:deploy
pnpm --filter @hitbox/database db:generate
pnpm --filter @hitbox/database db:seed:audit
```

There are two migrations. A new enum value can't be used in the transaction
that adds it, so they're split:

- `20261104100000_sku_exclusive_access_type` adds `ContentAccessType.SKU_EXCLUSIVE`.
- `20261104100100_drop_content` adds the `ContentBundleSerial` table, one
  regular bundle per drop (a partial unique index), and an index for a drop's
  exclusive tiers.

No new permission is needed. Media must have a bucket for uploads and links.
Without one, the tiers and the access rule still work, uploads answer
`CONTENT_REWARD_MEDIA_UNAVAILABLE`, and links are `null`.

---

## 9. Frontend checklists

**Artist panel: drop page, Content tab**

- [ ] `GET …/content`. Show the regular tier (or a "Create" button) and the list of exclusive tiers with their `serialNumbers` ("#001, #007").
- [ ] Create an exclusive tier: name, description, and a serial picker within `1…drop.totalSupply`. A range input that expands to a list is fine, up to `limits.maxSerialsPerTier`.
- [ ] Show `holders` ("1 owner can open this") and `openedBy`.
- [ ] Upload: request the upload URL, `PUT` the file with `requiredHeaders`, then add the item. Then show the tier returned.
- [ ] On/off toggle (`PATCH isActive`), remove and restore. Show a `moderation.locked` banner with `reason`.
- [ ] Map `409 DROP_CONTENT_REGULAR_EXISTS` to "Edit the existing regular content", using `details.bundleId`.

**Buyer app**

- [ ] Drop page: `GET /rewards/drops/:dropId`. For each locked `EXCLUSIVE` tier, show a badge like "Exclusive to #001" from `eligibleSerials`, plus `itemCounts`.
- [ ] Item screen (an owned unit): `GET /rewards/units/:skuId`. Show the unlocked tiers with players for VIDEO and AUDIO and viewers for GIF and IMAGE.
- [ ] Don't cache `url` past `expiresIn`. Refetch the endpoint.
- [ ] After a resale or transfer, refetch: access follows the unit.

---

## 10. Code map

| Where | What |
|---|---|
| `packages/content/prisma/content.prisma` | `ContentBundleSerial`, `ContentAccessType.SKU_EXCLUSIVE` |
| `packages/content/src/repository/drop-content.repository.ts` | Tiers, serials, owned units, holder and opened counts |
| `packages/content/src/service/drop-content.service.ts` | Artist-side rules: tiers, serials, files (`contentModule.dropContent`) |
| `packages/content/src/service/drop-content-access.service.ts` | Who opens what (buyer) |
| `packages/content/src/service/reward-files.ts` | File rules shared with collection rewards |
| `packages/content/src/controller/buyer-drop-content.controller.ts` | `/rewards/drops/:dropId`, `/rewards/units/:skuId` |
| `packages/artist/src/drop/` | Port `IDropContent`, DTOs, `ArtistDropContentService` (ownership and audit), controller |
| `packages/media/src/service/exclusive-content.service.ts` | Uploads for a drop (`dropId`) as well as a collection |
| `packages/content/tests/drop-content.test.ts`, `packages/artist/tests/artist-drop-content.test.ts` | Tests |
