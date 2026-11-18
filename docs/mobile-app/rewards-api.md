# Rewards — API

Collection rewards: exclusive content (videos, music, GIFs, images) that an
artist attaches to a collection. A buyer unlocks it by owning every drop in that
collection. It serves the **My Rewards** screen, the **reward player** screen,
and the locked **teaser** block on a collection or drop page.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/rewards` | required | My unlocked rewards (no files) |
| `GET` | `/rewards/collections/:collectionId` | required | Teaser: what a collection's reward holds and my progress |
| `GET` | `/rewards/:rewardId` | required | Open an unlocked reward: files with signed links |

Base path: `/api/v1/rewards`. Code: `packages/content` (buyer controller,
`RewardUnlockService`). The artist and staff sides are in
[../content/collection-rewards.md](../content/collection-rewards.md) and
[../content/admin-rewards-api.md](../content/admin-rewards-api.md).

---

## Authentication

Every route needs the Clerk session JWT:

```http
Authorization: Bearer <clerk-session-token>
```

The account also needs the `content-unlock:read` permission (own scope). Buyer
accounts (`BUYER_COLLECTOR`) have it. Without it → `403 AUTHZ_FORBIDDEN`. Auth
error codes (401/403) are listed in [auth-api.md](auth-api.md).

---

## Shapes

### `ItemCounts`

```jsonc
{ "VIDEO": 1, "AUDIO": 1, "GIF": 0, "IMAGE": 2 }   // all four keys, always present
```

### `CollectionRef`

```jsonc
{
  "id": "f80d2a6e-…",                     // artist collection id
  "name": "Season One",
  "slug": "kaze-season-one",
  "heroImageUrl": "https://cdn.example.com/collections/season-one.webp", // null if none
  "artist": { "id": "23ef81b0-…", "name": "Kaze", "slug": "kaze" }
}
```

### `RewardSummary`: one row on My Rewards

```jsonc
{
  "id": "8f1c3b2a-…",                     // → GET /rewards/:rewardId
  "publicCode": "cbd3k9x2",               // short human code; null if not assigned
  "name": "Season One — Tour film",
  "description": "Unseen footage from the tour.", // null if not set
  "collection": CollectionRef,
  "unlockedAt": "2026-11-03T11:02:00.000Z",
  "itemCounts": ItemCounts,               // "1 video · 1 track · 2 images"
  "itemTotal": 4
}
```

### `RewardDetail`: an opened reward

`RewardSummary` plus `items`:

```jsonc
{
  "…": "all RewardSummary fields",
  "items": [
    {
      "id": "d2e4…",
      "publicCode": "rwi8c1q0",           // null if not assigned
      "assetId": "a91e…",
      "kind": "VIDEO",                    // "VIDEO" | "AUDIO" | "GIF" | "IMAGE"; null if unknown type
      "title": "Backstage, night one",    // artist's title, else the file name
      "fileName": "backstage-01.mp4",
      "mimeType": "video/mp4",
      "sizeBytes": 184320000,             // null if unknown
      "position": 0,                      // display order, ascending
      "url": "https://storage.example.com/…&X-Amz-Signature=…", // signed link; null if not servable
      "expiresIn": 3600                   // seconds the url is valid; null when url is null
    }
  ]
}
```

| `kind` | MIME types | Render with |
|---|---|---|
| `VIDEO` | `video/mp4`, `video/webm`, `video/quicktime` | video player |
| `AUDIO` | `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/flac` | audio player |
| `GIF` | `image/gif` | animated image |
| `IMAGE` | `image/jpeg`, `image/png`, `image/webp` | image |

### `RewardTeaser`

```jsonc
{
  "reward": {
    "id": "8f1c3b2a-…",
    "name": "Season One — Tour film",
    "description": "Unseen footage from the tour.",
    "itemCounts": ItemCounts,
    "itemTotal": 4
  },
  "collection": CollectionRef,
  "progress": {
    "required": 3,                        // released drops in the collection
    "collected": 2,                       // how many of them I own a claimed unit of
    "missing": [                          // the ones still to collect
      { "dropId": "e001…", "publicCode": "drp4k2m1", "name": "Kaze — Tour Poster" }
    ],
    "complete": false                     // true when missing is empty (and required > 0)
  },
  "unlocked": false                       // true → show "Open reward"
}
```

The teaser never contains files or links.

---

## Endpoints

### `GET /api/v1/rewards`

The rewards I can open **right now**, newest unlock first. No parameters, no
pagination.

```jsonc
{
  "data": [ RewardSummary, … ]   // [] when none
}
```

Rewards that are paused or removed, or whose access ended, are left out.

### `GET /api/v1/rewards/collections/:collectionId`

Show this on a collection page, or on a drop page using the drop's
`collectionId` ([products-api.md](products-api.md)).

| Param | Type | Rules |
|---|---|---|
| `collectionId` | path | UUID of the artist collection |

```jsonc
{ "data": RewardTeaser }
```

| Status | Code | When |
|---|---|---|
| 404 | `CONTENT_REWARD_NOT_FOUND` | The collection has no reward, or it is paused/removed, or the collection is deleted. Hide the block. |
| 422 | `VALIDATION_ERROR` | `collectionId` is not a UUID |

### `GET /api/v1/rewards/:rewardId`

Open an unlocked reward.

| Param | Type | Rules |
|---|---|---|
| `rewardId` | path | UUID of the reward |

```jsonc
{ "data": RewardDetail }
```

| Status | Code | When |
|---|---|---|
| 403 | `CONTENT_REWARD_LOCKED` | Not unlocked, or access ended. `error.details.collectionId` → open the teaser for that collection. |
| 404 | `CONTENT_REWARD_NOT_FOUND` | No such reward, or it is paused/removed, or its collection is deleted |
| 422 | `VALIDATION_ERROR` | `rewardId` is not a UUID |

```json
{
  "error": {
    "code": "CONTENT_REWARD_LOCKED",
    "message": "Collect every drop of this collection to unlock it.",
    "details": { "collectionId": "f80d2a6e-…" }
  }
}
```

Each successful open is recorded (first open, last open, open count) for the
artist's stats. This does not affect access.

---

## How it works

### The unlock rule

A buyer unlocks a collection's reward when they **own a claimed unit of every
released drop** in that collection.

| Term | Meaning |
|---|---|
| Released drop | A drop in the collection with status `PUBLISHED`, `ACTIVE` or `ENDED`, not archived. Drafts and drops in review do not count. |
| Own | The unit is claimed by NFC tap and is yours ([claims-nfc-api.md](claims-nfc-api.md)). Paid but not claimed does **not** count. |
| Every | One unit of each drop. Two copies of one drop do not make up for a missing drop. |

A collection with no released drops cannot be completed.

### When it unlocks

1. **On a claim.** After each claim, the drop's collection is checked. If the
   set is now complete and the reward is on, it unlocks.
2. **When the artist turns a reward on** (create, switch on, restore). Everyone
   who already holds the full set unlocks it at once.
3. **On the teaser.** If `GET /rewards/collections/:id` finds the set complete
   but no unlock, it unlocks it right then and returns `unlocked: true`.

There is no push of the unlock itself in this API. After a `CLAIMED` result,
refresh the teaser or `GET /rewards` to show it.

### Keeping and losing it

- **An unlock lasts.** If the artist adds a new drop to the collection later,
  existing unlocks stay. New buyers need the new drop too.
- **Losing a piece ends access.** When a claim is revoked (refund, lost dispute)
  and you no longer own any unit of that drop, access ends. It comes back as
  soon as you complete the set again.
- **The reward must be on.** If the artist pauses or removes it, or the
  collection is deleted, nobody can open it (`404`). Unlocks are kept and work
  again when it is back on.

### Signed links

- Each `items[].url` is a private, signed link valid for `expiresIn` seconds
  (**3600**, one hour). Use it directly as the player or image source.
- Do not store or cache links past `expiresIn`. To get fresh links, call
  `GET /rewards/:rewardId` again.
- `url` is `null` when the file is not servable (still being scanned, removed,
  or flagged by the virus scan) or the server has no storage bucket. Show the
  item as unavailable.

### Typical screen flow

1. Collection / drop page → teaser. On 404, hide the block.
2. Not unlocked → "Collect N more drops", list `progress.missing` with links to
   `GET /products/:dropId`.
3. `unlocked: true` → "Open reward" → `GET /rewards/:rewardId`.
4. My Rewards screen → `GET /rewards`.
5. On `403 CONTENT_REWARD_LOCKED` → open the teaser for `details.collectionId`.

---

## Known limitations

- **No pagination on `GET /rewards`.** It returns every live unlock.
- **One reward per collection**, with at most 20 files.
- **`itemCounts` skips unknown types.** A file whose MIME type is not in the
  table above is in `itemTotal` but not in `itemCounts`, and has `kind: null`.
- **The teaser can write.** Despite being a `GET`, it grants the reward when it
  finds a complete set without an unlock.
