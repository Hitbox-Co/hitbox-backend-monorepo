# Collection rewards

> **Collect every drop of an artist's collection and unlock exclusive
> content.** An artist attaches a reward to one of their collections: videos,
> music, GIFs, and images such as posters. A buyer who owns every released
> drop of that collection unlocks it, and can then stream or download the
> files through private links.
>
> - Artist panel: `/api/v1/artist/collections/:collectionId/reward` (3)
> - Buyer app: `/api/v1/rewards` (4)
> - HitBox staff (monitoring, switch off, remove): `/api/v1/admin/rewards`, in
>   [admin-rewards-api.md](admin-rewards-api.md)

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

**A buyer unlocks a collection's reward when they own a claimed unit of every
released drop in that collection.**

| Term | Meaning |
|---|---|
| **Released drop** | A drop in the collection with status `PUBLISHED`, `ACTIVE` or `ENDED`, not archived. Drafts and drops in review don't count, because nobody can own one yet. |
| **Owns** | Owns a unit they have **claimed**: tapped the NFC tag, so it's on their collection shelf. A unit that's been paid for but not claimed doesn't count. |
| **Every** | One unit of each released drop is enough. Owning two of one drop doesn't make up for a missing one. |

A collection with no released drops can't be completed.

**When the rule is checked**

| Moment | What happens |
|---|---|
| A buyer claims a unit (`claims.product.claimed`) | The drop's collection is checked; if the set is now complete, the reward unlocks. |
| The artist creates the reward, switches it on, or restores it | Everyone who already holds the full set unlocks it **at once**. |
| A buyer opens the teaser (4.3) while holding the set but without a grant | Granted on the spot. This is a safety net if an event was missed. |

**Keeping it**

- **An unlock lasts.** If the artist later adds a drop to the collection,
  people who already unlocked the reward keep it. New buyers need the new
  drop too.
- **Losing a piece ends access.** If a claim is revoked (a refund or a lost
  dispute) and the buyer no longer owns any unit of that drop, they lose
  access. It comes back as soon as they complete the set again.
- **The reward must be on.** If the artist pauses it (`isActive: false`),
  removes it, or deletes the collection, nobody can open it. Their unlocks are
  kept and work again when it's switched back on.

There's **one reward per collection**. It can hold up to 20 files.

---

## 2. How it fits together

```
 Artist panel ─▶ artist module ── proves "this is my live collection" ──┐
                                                                        ▼
 Buyer app ─────────────────────────────────────────────▶ content module ──▶ media module
                                                     (rewards, the rule,     (private files,
                                                      unlocks)                signed links)
                                                          ▲
 claims module ── claims.product.claimed / claim.revoked ─┘
```

| Module | Owns |
|---|---|
| `@hitbox/content` | The reward (`ContentBundle`, `accessType = COLLECTION_COMPLETE`), its files (`ContentBundleItem`), the buyers' unlocks (`ContentUnlock`) and the rule |
| `@hitbox/artist` | Who may manage a collection's reward: its owner, with a live collection and an editable profile. It calls content through its `ICollectionRewards` port. |
| `@hitbox/media` | The files (`MediaAsset`, type `EXCLUSIVE_CONTENT`) under the private prefix `exclusive-content/collections/{collectionId}/`, plus upload URLs and signed links (`IRewardMedia`) |
| `@hitbox/claims` | Who owns what. It publishes the claim and revocation events the rule listens to. |

No module reads another's tables for writing. The one shortcut is that the
content module reads `Drop` and `Sku` directly, read-only, to answer "has this
buyer collected the set?". That's the same documented shortcut the artist
module takes for drops.

---

## 3. Artist panel API

All routes are under `/api/v1/artist/collections/:collectionId/reward`. They
need the artist's own session and the same permissions as the rest of the
artist's collections (`brand-artist-record:read|update:own`).

- The collection has to be **yours**. Anyone else's is `404`, the same as a
  missing one.
- Changes need a **live** collection (`409 ARTIST_COLLECTION_ARCHIVED`) and an
  **editable** profile (`409 ARTIST_PROFILE_LOCKED`). Reading is always
  allowed.

| # | Route | What it does |
|---|---|---|
| 3.1 | `GET …/reward` | The reward with its files (and preview links), or `data: null` if there's none yet |
| 3.2 | `PUT …/reward` | Create it, edit it, pause or switch it on, or restore a removed one |
| 3.3 | `DELETE …/reward` | Remove it |
| 3.4 | `POST …/reward/items/upload-url` | Step 1 of adding a file: get an upload URL |
| 3.5 | `POST …/reward/items` | Step 2: put the uploaded file into the reward |
| 3.6 | `PATCH …/reward/items/:itemId` | Rename a file |
| 3.7 | `PUT …/reward/items/order` | Reorder the files |
| 3.8 | `DELETE …/reward/items/:itemId` | Take a file out |

Every route except 3.1 and 3.4 returns the **whole reward** (3.1's shape), so
the screen can replace its state with `data`.

### 3.1 `GET …/reward`

```json
{
  "data": {
    "id": "8f1c…",
    "publicCode": "cbd…",
    "collectionId": "f80d…",
    "name": "Season One — Tour film",
    "description": "Unseen footage from the Neon Nights tour.",
    "status": "ON",
    "isActive": true,
    "archivedAt": null,
    "items": [
      {
        "id": "2a7e…",
        "publicCode": "cbi…",
        "assetId": "41bd…",
        "kind": "VIDEO",
        "title": "Tour film",
        "fileName": "tour-film.mp4",
        "mimeType": "video/mp4",
        "sizeBytes": 248112640,
        "position": 0,
        "url": "https://…s3…?X-Amz-…",
        "expiresIn": 3600
      },
      { "id": "…", "kind": "AUDIO", "title": "Demo — Neon Nights", "position": 1, "…": "…" },
      { "id": "…", "kind": "IMAGE", "title": "Tour poster", "position": 2, "…": "…" }
    ],
    "itemCounts": { "VIDEO": 1, "AUDIO": 1, "GIF": 0, "IMAGE": 1 },
    "unlockedCount": 14,
    "requiredDrops": 3,
    "createdAt": "2026-11-03T10:00:00.000Z",
    "updatedAt": "2026-11-03T10:20:00.000Z"
  }
}
```

| Field | Meaning |
|---|---|
| `status` | `ON`: buyers unlock and open it. `OFF`: paused. `REMOVED`: deleted; restore it with `PUT`. |
| `moderation` | `{ locked, reason, lockedAt }`. `locked` is `true` when **HitBox** switched it off or removed it. You can still edit it, but you can't switch it on or restore it until HitBox lifts the lock. Show the `reason`. ([admin-rewards-api.md 5](admin-rewards-api.md#5-what-the-artist-and-buyers-see)) |
| `unlockedCount` | Buyers who have it unlocked right now |
| `requiredDrops` | How many released drops a buyer must collect |
| `items[].url` | Signed preview link for the artist, valid for `expiresIn` seconds. Don't store it. |
| `items[].kind` | `VIDEO`, `AUDIO`, `GIF` or `IMAGE` |
| `items[].title` | Your title, or the file name if you didn't give one |

### 3.2 `PUT …/reward`

```json
{ "name": "Season One — Tour film", "description": "Unseen footage from the tour.", "isActive": true }
```

| Field | Rules |
|---|---|
| `name` | Required, 1–120 characters |
| `description` | Optional, up to 2000 characters; `""` or `null` clears it |
| `isActive` | Optional. Defaults to `true` when creating. `false` pauses the reward: nobody new unlocks it and nobody can open it. |

- **Creates** the reward if the collection has none, and **edits** it
  otherwise.
- **Restores** a removed reward, with its files and its buyers' unlocks.
- Whenever a save leaves the reward on when it wasn't before (new, restored,
  or switched back on), **every buyer who already holds the full set unlocks
  it immediately**. The audit row records how many
  (`metadata.newlyUnlocked`).

### 3.3 `DELETE …/reward`

Removes it (`status: "REMOVED"`). Buyers can't open it, and nobody new unlocks
it. Nothing is deleted: its files and unlocks are kept, so `PUT` brings it all
back. Removing it again changes nothing.

### 3.4 `POST …/reward/items/upload-url`: step 1

```json
{ "fileName": "tour-film.mp4", "mimeType": "video/mp4", "sizeBytes": 248112640 }
```

Response `201`:

```json
{
  "data": {
    "assetId": "41bd…",
    "uploadUrl": "https://…s3…?X-Amz-…",
    "expiresIn": 300,
    "requiredHeaders": { "Content-Type": "video/mp4" },
    "kind": "VIDEO"
  }
}
```

Then upload the file **directly to S3**: `PUT uploadUrl` with the file as the
body and exactly `requiredHeaders`. The size must match `sizeBytes` exactly,
because S3 rejects any other length. The URL expires after `expiresIn`
seconds. Allowed types and sizes are in 5.

The reward needs to exist first (`404 CONTENT_REWARD_NOT_FOUND`) and not be
removed (`409 CONTENT_REWARD_ARCHIVED`).

### 3.5 `POST …/reward/items`: step 2

```json
{ "assetId": "41bd…", "title": "Tour film" }
```

`title` is optional, up to 200 characters. The file goes **at the end**. It's
refused with `400 CONTENT_REWARD_FILE_INVALID` when:

- it doesn't exist, or wasn't uploaded to **this** collection;
- the upload hasn't finished (step 1's `PUT` didn't arrive);
- it was deleted or failed the virus scan;
- it isn't a video, music track, GIF or image.

It's also refused with `409 CONTENT_REWARD_FILE_DUPLICATE` if it's already in
the reward, and with `409 CONTENT_REWARD_TOO_MANY_ITEMS` if the reward
already has 20 files.

Response `201`: the reward.

### 3.6 `PATCH …/reward/items/:itemId`

```json
{ "title": "Tour film (director's cut)" }
```

Send `null` or `""` to fall back to the file name.

### 3.7 `PUT …/reward/items/order`

```json
{ "itemIds": ["9c…", "2a7e…", "51…"] }
```

The body must list **every** item of the reward, each once, in the new
order. Anything else is `400 CONTENT_REWARD_ORDER_MISMATCH`, with
`details.itemIds` giving the current list.

### 3.8 `DELETE …/reward/items/:itemId`

Takes the file out and closes the gap in positions. The file itself is kept
in storage (history and audits).

---

## 4. Buyer API

All routes are under `/api/v1/rewards`. They need the buyer's own session and
`content-unlock:read:own` (role `BUYER_COLLECTOR`).

| # | Route | What it does |
|---|---|---|
| 4.1 | `GET /rewards` | My unlocked rewards |
| 4.2 | `GET /rewards/:rewardId` | Open one: the files with their links |
| 4.3 | `GET /rewards/collections/:collectionId` | The teaser: what's in a collection's reward, and how close I am |

### 4.1 `GET /rewards`

The rewards the buyer can open right now, newest unlock first:

```json
{
  "data": [
    {
      "id": "8f1c…",
      "publicCode": "cbd…",
      "name": "Season One — Tour film",
      "description": "Unseen footage from the tour.",
      "collection": {
        "id": "f80d…", "name": "Season One", "slug": "kaze-season-one", "heroImageUrl": "https://…",
        "artist": { "id": "23ef…", "name": "Kaze", "slug": "kaze" }
      },
      "unlockedAt": "2026-11-03T11:02:00.000Z",
      "itemCounts": { "VIDEO": 1, "AUDIO": 1, "GIF": 0, "IMAGE": 1 },
      "itemTotal": 3
    }
  ]
}
```

### 4.2 `GET /rewards/:rewardId`

Same shape as 4.1, plus `items[]`, which has the same fields as the artist's
view (3.1). Each item has a signed `url` valid for `expiresIn` seconds (an
hour). Use it directly as a `<video>` / `<audio>` / `<img>` source or a
download link. Fetch the reward again for fresh links; don't store them.

| Status | Code | When |
|---|---|---|
| `403` | `CONTENT_REWARD_LOCKED` | Not unlocked (or access ended). `details.collectionId` points at the teaser (4.3). |
| `404` | `CONTENT_REWARD_NOT_FOUND` | No such reward, or it's paused or removed |

Opening a reward records `lastAccessedAt`, `accessCount` and (the first time)
`acknowledgedAt` on the unlock. That's engagement data, not access control.

### 4.3 `GET /rewards/collections/:collectionId`: the teaser

Show this on a collection page. It lists what's in the reward, but **never the
files**:

```json
{
  "data": {
    "reward": {
      "id": "8f1c…",
      "name": "Season One — Tour film",
      "description": "Unseen footage from the tour.",
      "itemCounts": { "VIDEO": 1, "AUDIO": 1, "GIF": 0, "IMAGE": 1 },
      "itemTotal": 3
    },
    "collection": { "id": "f80d…", "name": "Season One", "…": "…" },
    "progress": {
      "required": 3,
      "collected": 2,
      "missing": [{ "dropId": "e001…", "publicCode": "drp…", "name": "Kaze — Tour Poster" }],
      "complete": false
    },
    "unlocked": false
  }
}
```

`404 CONTENT_REWARD_NOT_FOUND` means the collection has no reward that's on.
When `unlocked` is `true`, link to 4.2.

---

## 5. Files: types, sizes, links

| Kind | Types | Max size |
|---|---|---|
| `VIDEO` | `video/mp4`, `video/webm`, `video/quicktime` | 500 MB |
| `AUDIO` (music) | `audio/mpeg` (mp3), `audio/mp4` (m4a), `audio/aac`, `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/flac` | 100 MB |
| `GIF` | `image/gif` | 50 MB |
| `IMAGE` (posters, artwork) | `image/jpeg`, `image/png`, `image/webp` | 25 MB |

Anything else (PDFs, archives and so on) is refused at step 1 with
`400 CONTENT_REWARD_FILE_TYPE`, with `details.allowed` listing the accepted
types. A file over its size limit gives the same code with
`details.maxBytes`.

**Privacy.** Reward files live under `exclusive-content/collections/…`, a
prefix with no public access, so there's never a permanent URL. Each view is a
signed GET that lasts **one hour**. That's long enough for a video or track
to finish playing (every range request is checked against the signature), and
short enough that a copied link stops working. Links are only issued to the
artist who owns the collection and to buyers who have it unlocked.

---

## 6. Audit trail and events

**Audited** (persona `artist`, actor type `ARTIST`, resource `ContentBundle`).
Each row has before/after snapshots of the name, status and files, plus
`metadata.collectionId` and `metadata.artistId`:

| Event | Severity | When |
|---|---|---|
| `artist.collection.reward.save` | INFO | Created, edited, paused, switched on or restored. `metadata.created`, `restored`, `newlyUnlocked` and `fields`. |
| `artist.collection.reward.remove` | WARNING | Removed |
| `artist.collection.reward.item.add` | INFO | A file was added. `metadata.assetId`, `itemId` and `kind`. |
| `artist.collection.reward.item.update` | INFO | Renamed or reordered. `metadata.action` is `rename` or `reorder`. |
| `artist.collection.reward.item.remove` | INFO | A file was taken out |

Getting an upload URL isn't audited, because nothing has changed yet.

**Published on the bus:**

| Event | Payload | From |
|---|---|---|
| `artist.collection.reward-saved` | `{ collectionId, artistId, rewardId, status, itemCount }` | artist: save, add or remove a file |
| `artist.collection.reward-removed` | same | artist: remove |
| `content.reward.unlocked` | `{ rewardId, collectionId, userId }` | content: once per buyer per unlock. Use it for "You unlocked…" notifications. |
| `content.reward.access-lost` | `{ rewardId, collectionId, userId, droppedProductId }` | content: a revoked claim broke the buyer's set |

`claims.claim.revoked` now also carries `userId` (the previous owner) and
`productId`, which the rule needs.

---

## 7. Errors

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Malformed body or id |
| `400` | `CONTENT_REWARD_FILE_TYPE` | Not a video, music track, GIF or image, or over the size for its kind |
| `400` | `CONTENT_REWARD_FILE_INVALID` | Missing, not this collection's, not uploaded yet, deleted, or infected |
| `400` | `CONTENT_REWARD_ORDER_MISMATCH` | The reorder list isn't exactly the reward's files |
| `400` | `CONTENT_REWARD_MEDIA_UNAVAILABLE` | No storage bucket on this server |
| `400` | `ARTIST_COLLECTION_REWARDS_UNAVAILABLE` | The content module isn't wired on this server |
| `403` | `CONTENT_REWARD_LOCKED` | Buyer: not unlocked. `details.collectionId` is included. |
| `403` | `AUTHZ_FORBIDDEN` | Missing the role's permission |
| `404` | `ARTIST_COLLECTION_NOT_FOUND` | Not your collection, or it doesn't exist |
| `404` | `CONTENT_REWARD_NOT_FOUND` | No reward (artist), or none that's on (buyer) |
| `404` | `CONTENT_REWARD_ITEM_NOT_FOUND` | No such file in the reward |
| `404` | `ARTIST_PROFILE_NOT_FOUND` | Your account has no artist profile |
| `409` | `ARTIST_COLLECTION_ARCHIVED` | The collection is deleted. Restore it first. |
| `409` | `ARTIST_PROFILE_LOCKED` | Your profile is deactivated or archived |
| `409` | `CONTENT_REWARD_ARCHIVED` | The reward is removed. `PUT` it again first. |
| `409` | `CONTENT_REWARD_FILE_DUPLICATE` | The file is already in the reward |
| `409` | `CONTENT_REWARD_TOO_MANY_ITEMS` | The reward already has 20 files |
| `409` | `CONTENT_REWARD_MODERATION_LOCKED` | HitBox switched it off or removed it; `details.reason` says why. Switching it on or restoring it is refused until HitBox lifts the lock. |

---

## 8. Setup

Two migrations:

- `20261103100000_collection_reward_access_type`: adds `COLLECTION_COMPLETE`
  to `ContentAccessType`. It's on its own because Postgres can't use a new
  enum value in the transaction that adds it.
- `20261103100100_collection_rewards`: adds `ContentBundleItem.title`, a
  partial unique index allowing **one** `COLLECTION_COMPLETE` bundle per
  collection, and a partial unique index allowing **one** grant per buyer per
  bundle (`WHERE skuId IS NULL`; the table's own unique treats a null `skuId`
  as distinct).

Run these per environment:

```bash
pnpm db:deploy
```

```bash
pnpm db:seed:audit
```

Rewards need a storage bucket (`MEDIA_S3_BUCKET`). Without one, uploads and
links answer `CONTENT_REWARD_MEDIA_UNAVAILABLE` and links are `null`, but the
rule still runs. No new permissions are needed: artists use their existing
own-scope collection grants, and buyers use `content-unlock:read:own`.

---

## 9. Frontend checklists

**Artist panel: a "Reward" tab on each collection**
- [ ] `GET …/reward`. If `data` is `null`, show "Add a reward". Otherwise show the name, status badge (`ON`/`OFF`/`REMOVED`), `unlockedCount` and "Collect all `requiredDrops` drops to unlock".
- [ ] Create/edit form → `PUT …/reward`, with an on/off switch → `isActive`.
- [ ] "Remove reward" → `DELETE …/reward`. For `REMOVED`, offer "Restore" (a `PUT` with the name).
- [ ] Upload: pick a file → `POST …/items/upload-url` with `file.size` → `PUT` the file to `uploadUrl` with `requiredHeaders` (show progress) → `POST …/items` with `assetId` and an optional title.
- [ ] Restrict the file picker to the types in 5 and check sizes before uploading.
- [ ] Item list with previews (`url` in `<video>`, `<audio>` or `<img>`), rename (`PATCH`), drag-to-reorder (`PUT …/items/order` with every id), and remove (`DELETE`).
- [ ] Replace screen state with `data` after every call.
- [ ] If `moderation.locked`, show a banner like "Switched off by HitBox: {reason}" and disable the on switch and the restore button.

**Buyer app**
- [ ] Collection page: `GET /rewards/collections/:id`. On 404, show nothing. Otherwise show a locked teaser ("3 videos, 1 track · Collect 2 more drops"), list `progress.missing` with links to those drops, and when `unlocked` is true, an "Open reward" button.
- [ ] "My rewards" screen: `GET /rewards`.
- [ ] Reward screen: `GET /rewards/:id`, then play or show each item by `kind` from `url`. Refetch when links expire (`expiresIn`), and don't cache them.
- [ ] On `403 CONTENT_REWARD_LOCKED`, send the buyer to the teaser for `details.collectionId`.
- [ ] When the notifications module listens to `content.reward.unlocked`, show "You unlocked *{name}*".

---

## 10. Code map

```
packages/content/
  prisma/content.prisma                       ContentBundle / Item (title) / Unlock, COLLECTION_COMPLETE
  src/constants/content.constant.ts           error codes, events, limits, released statuses
  src/domain/reward-kind.ts                   MIME → VIDEO | AUDIO | GIF | IMAGE
  src/domain/reward-media.port.ts             IRewardMedia — media implements it
  src/repository/content.repository.ts        rewards, items, grants, the completion queries
  src/service/reward-unlock.service.ts        THE RULE: onClaimed, onClaimRevoked, grantToCompleters; buyer views
  src/service/collection-reward.service.ts    artist-side operations (behind the artist's port)
  src/controller/buyer-reward.controller.ts   /rewards
  src/module.ts                               event subscriptions, buyer router
  tests/collection-rewards.test.ts
packages/artist/src/collection/
  domain/collection-rewards.port.ts           ICollectionRewards — content implements it
  dto/collection-reward.dto.ts                request schemas
  service/artist-reward.service.ts            ownership, locks, audit, events
  controller/artist-collection.controller.ts  ArtistRewardController
packages/artist/tests/artist-collection-reward.test.ts
packages/media/src/service/exclusive-content.service.ts   uploads, inspect, 1-hour signed links
packages/claims/src/service/claims.service.ts             claim.revoked now carries userId + productId
apps/backend/src/bootstrap.ts, routes.ts                  wiring; /api/v1/rewards
packages/audit/src/domain/audit-event-catalog.ts          artist.collection.reward.*
```
