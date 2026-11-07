# Collection rewards: admin monitoring and moderation API

> HitBox staff can see every collection reward on the platform: what it
> holds, who unlocked it and how often they open it. They can also switch a
> reward **off** or **remove** it, for example to take down infringing or
> inappropriate content. Everything is under **`/api/v1/admin/rewards`**.
>
> How rewards work (the rule, the artist panel, the buyer app) is in
> [collection-rewards.md](collection-rewards.md).

---

## Contents

1. [Who can call this](#1-who-can-call-this)
2. [Routes](#2-routes)
3. [Monitoring](#3-monitoring)
4. [Moderation: switch off, switch on, remove, restore](#4-moderation-switch-off-switch-on-remove-restore)
5. [What the artist and buyers see](#5-what-the-artist-and-buyers-see)
6. [Audit trail and events](#6-audit-trail-and-events)
7. [Errors](#7-errors)
8. [Setup](#8-setup)
9. [Console checklist](#9-console-checklist)
10. [Code map](#10-code-map)

---

## 1. Who can call this

Every route needs `content-unlock:manage` **platform-wide** (`globalOnly`):

| Role (seeded) | Access |
|---|---|
| `HITBOX_SYSTEM_ADMIN` | ✅ (`content-unlock:manage:global`) |
| `HITBOX_CONTENT_MANAGER` | ✅ (`content-unlock:manage:global`). This is the role whose job is content. |
| Brand Admin, Brand Employee, Artist | ❌ `403`. Their `:organization` grant doesn't qualify. |
| Buyers | ❌ `403` |

This is a permission check, not a role name. A role an operator later defines
with `content-unlock:manage:global` gets the same access with no code change.
To keep moderation to System Admin only, take that grant off Content Manager
in `packages/access-control/src/domain/role-catalog.ts`.

---

## 2. Routes

| # | Route | What it does |
|---|---|---|
| 3.1 | `GET /admin/rewards` | Every reward, with filters |
| 3.2 | `GET /admin/rewards/summary` | Dashboard tiles and the most-unlocked rewards |
| 3.3 | `GET /admin/rewards/:rewardId` | One reward: its files (with preview links) and moderation state |
| 3.4 | `GET /admin/rewards/:rewardId/unlocks` | Who unlocked it, and how they use it |
| 4.1 | `POST /admin/rewards/:rewardId/switch-off` | Switch it off and lock it |
| 4.2 | `POST /admin/rewards/:rewardId/switch-on` | Lift a HitBox switch-off |
| 4.3 | `POST /admin/rewards/:rewardId/remove` | Remove it and lock it |
| 4.4 | `POST /admin/rewards/:rewardId/restore` | Lift a HitBox removal |

---

## 3. Monitoring

### 3.1 `GET /admin/rewards`

| Query | Values |
|---|---|
| `status` | `ON` · `OFF` · `REMOVED` · `LOCKED` (switched off or removed **by HitBox**) |
| `artistId` | One artist's rewards |
| `collectionId` | One collection's reward |
| `q` | Reward, collection or artist name, case-insensitive |
| `page`, `limit` | Default `1`, `20`; `limit` ≤ 100 |

Results are sorted with the most recently changed first.

```json
{
  "page": 1,
  "limit": 20,
  "total": 1,
  "items": [
    {
      "id": "8f1c…",
      "publicCode": "cbd…",
      "name": "Season One — Tour film",
      "status": "ON",
      "isActive": true,
      "archivedAt": null,
      "collection": {
        "id": "f80d…", "name": "Season One", "slug": "kaze-season-one", "heroImageUrl": null,
        "artist": { "id": "23ef…", "name": "Kaze", "slug": "kaze" },
        "deleted": false
      },
      "itemCounts": { "VIDEO": 1, "AUDIO": 1, "GIF": 0, "IMAGE": 1 },
      "itemTotal": 3,
      "unlockedCount": 14,
      "moderation": { "locked": false, "reason": null, "lockedAt": null, "byId": null },
      "createdAt": "2026-11-03T10:00:00.000Z",
      "updatedAt": "2026-11-03T10:20:00.000Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `ON` / `OFF` / `REMOVED`, whoever did it |
| `moderation.locked` | `true` while a HitBox switch-off or removal stands. `byId` is the staff member who made the last moderation change. |
| `unlockedCount` | Buyers who can open it **right now** |
| `collection.deleted` | The artist deleted the collection. The reward can't be opened while that's so. |

### 3.2 `GET /admin/rewards/summary`

```json
{
  "data": {
    "rewards": { "total": 12, "on": 9, "off": 1, "removed": 2, "lockedByHitbox": 1 },
    "unlocks": { "live": 312, "thisMonth": 48, "buyersWithRewards": 201 },
    "topRewards": [
      {
        "id": "8f1c…", "name": "Season One — Tour film", "unlockedCount": 140,
        "collection": { "id": "f80d…", "name": "Season One" },
        "artist": { "id": "23ef…", "name": "Kaze" }
      }
    ]
  }
}
```

- `unlocks.live` counts unlocks in force now.
- `thisMonth` counts unlocks granted since the 1st of this month (UTC).
- `buyersWithRewards` counts distinct buyers holding at least one.
- `topRewards` lists the five rewards with the most live unlocks.

### 3.3 `GET /admin/rewards/:rewardId`

The list row (3.1), plus:

| Field | Meaning |
|---|---|
| `description` | The artist's description |
| `items[]` | Every file: `kind`, `title`, `fileName`, `mimeType`, `sizeBytes`, `position`, and a signed preview `url` (valid `expiresIn` seconds, one hour) so staff can review the content itself. Don't store links. |
| `requiredDrops` | Released drops a buyer must collect |
| `auditTrail` | `{ resourceType: "ContentBundle", resourceId }`. Pass these to `GET /api/v1/admin/audit/events?resourceType=ContentBundle&resourceId=<id>` for the full history, covering the artist's changes and HitBox's moderation. |

### 3.4 `GET /admin/rewards/:rewardId/unlocks`

| Query | Values |
|---|---|
| `status` | `LIVE` (can open it now) · `ENDED` (lost it when a piece of the set was taken back). Omit for both. |
| `page`, `limit` | Default `1`, `20` |

```json
{
  "page": 1,
  "limit": 20,
  "total": 2,
  "items": [
    {
      "id": "…", "publicCode": "cul…",
      "buyer": { "userId": "b1…", "handle": "mia", "fullName": "Mia Lee" },
      "status": "LIVE",
      "unlockedAt": "2026-11-03T11:02:00.000Z",
      "endedAt": null,
      "firstOpenedAt": "2026-11-03T11:05:00.000Z",
      "lastOpenedAt": "2026-11-04T08:40:00.000Z",
      "timesOpened": 4
    }
  ]
}
```

Results are sorted newest unlock first. Buyers are identified by handle and
name. **Email is not included**; look the buyer up through the users API
(`buyer-profile` grants) if you need contact details.

---

## 4. Moderation: switch off, switch on, remove, restore

**Moderation is a lock.** When HitBox switches a reward off or removes it,
`moderation.locked` becomes `true`, and while it's locked:

- the **artist** can still edit the name, description and files, but **can't
  switch it on or restore it** (`409 CONTENT_REWARD_MODERATION_LOCKED`, with
  the reason);
- **buyers** can't open it, and nobody new unlocks it;
- only staff can lift it, with `switch-on` or `restore`.

**Staff only undo what staff did.** If the *artist* paused or removed their own
reward, it's theirs to bring back: `switch-on` and `restore` on such a reward
answer `409 CONTENT_REWARD_NOT_MODERATED`.

**Nothing is deleted.** Files and buyers' unlocks are kept throughout. Lifting
the lock opens the reward again for everyone who had it, and grants it to
anyone who completed the set while it was down (`metadata.newlyUnlocked` on
the audit row).

Every action returns the reward detail (3.3) in `data`.

### 4.1 `POST …/switch-off`

```json
{ "reason": "The video contains copyrighted music. Replace it and contact support." }
```

A `reason` (1–500 characters) is **required**; the artist sees it.

- Effect: `isActive: false`, locked.
- Refused with `409 CONTENT_REWARD_STATE_UNCHANGED` if it's already off.
- Refused with `409 CONTENT_REWARD_ARCHIVED` if it's removed; restore it
  first.

### 4.2 `POST …/switch-on`

```json
{ "reason": "Reviewed: the music was replaced." }
```

`reason` is optional.

- Effect: `isActive: true`, lock lifted, and buyers who completed the set
  meanwhile get it.
- Refused with `409 CONTENT_REWARD_STATE_UNCHANGED` if it's already on.
- Refused with `409 CONTENT_REWARD_NOT_MODERATED` if the artist paused it
  themselves.
- Refused with `409 CONTENT_REWARD_ARCHIVED` if it's removed.

### 4.3 `POST …/remove`

```json
{ "reason": "Explicit content in the poster." }
```

A `reason` is **required**.

- Effect: removed (`status: "REMOVED"`), locked.
- Refused with `409 CONTENT_REWARD_STATE_UNCHANGED` if it's already removed.

### 4.4 `POST …/restore`

```json
{ "reason": "Poster replaced." }
```

`reason` is optional.

- Effect: un-removed and the lock lifted. If HitBox had also switched it off,
  it comes back **off**, but unlocked, so the artist can switch it on.
- Refused with `409 CONTENT_REWARD_STATE_UNCHANGED` if it isn't removed.
- Refused with `409 CONTENT_REWARD_NOT_MODERATED` if the artist removed it
  themselves.

| From → action | `switch-off` | `switch-on` | `remove` | `restore` |
|---|---|---|---|---|
| ON | OFF 🔒 | 409 unchanged | REMOVED 🔒 | 409 unchanged |
| OFF (by artist) | 409 unchanged | 409 not moderated | REMOVED 🔒 | 409 unchanged |
| OFF 🔒 (by HitBox) | 409 unchanged | ON | REMOVED 🔒 | 409 unchanged |
| REMOVED (by artist) | 409 archived | 409 archived | 409 unchanged | 409 not moderated |
| REMOVED 🔒 (by HitBox) | 409 archived | 409 archived | 409 unchanged | lock lifted (ON or OFF, as it was) |

🔒 = locked by HitBox.

---

## 5. What the artist and buyers see

**Artist panel** (`GET /artist/collections/:id/reward`): every reward now
carries:

```json
"moderation": { "locked": true, "reason": "The video contains copyrighted music…", "lockedAt": "2026-11-03T14:00:00.000Z" }
```

Show a banner like "Switched off by HitBox: {reason}". While it's locked, a
`PUT` that would switch it on or restore it gets
`409 CONTENT_REWARD_MODERATION_LOCKED` with `details.reason`. Other edits work
as usual.

**Buyers**: a switched-off or removed reward behaves as if it weren't there.
It's missing from `GET /rewards`, and the teaser and detail answer
`404 CONTENT_REWARD_NOT_FOUND`. Their unlock isn't lost, so it reappears when
the lock is lifted.

---

## 6. Audit trail and events

Every moderation action is audited with persona `hitbox_admin`, actor type
`HITBOX_ADMIN`, the passing role as `actorRoleSnapshot`, and resource
`ContentBundle`. Rows carry before/after state (`isActive`, `archivedAt`,
`moderationLockedAt`, `moderationReason`) and `metadata`: `action`,
`collectionId`, `artistId`, `reason`, and `newlyUnlocked` when the reward
came back.

| Event | Severity |
|---|---|
| `content.reward.switch-off` | WARNING |
| `content.reward.switch-on` | INFO |
| `content.reward.remove` | WARNING |
| `content.reward.restore` | INFO |

The artist's own reward changes are `artist.collection.reward.*`
([collection-rewards.md 6](collection-rewards.md#6-audit-trail-and-events)).
Both share the same `resourceId`, so one audit query (3.3 `auditTrail`) shows
the whole story.

**Bus event** `content.reward.moderated`:
`{ rewardId, collectionId, artistId, action, reason, actorId }`. A
notifications subscriber can tell the artist "HitBox switched off your
reward: {reason}".

---

## 7. Errors

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Bad query or body: an unknown status, a missing `reason` on switch-off or remove, an id that isn't a UUID |
| `403` | `AUTHZ_FORBIDDEN` | No platform-wide `content-unlock:manage` |
| `404` | `CONTENT_REWARD_NOT_FOUND` | No such reward |
| `409` | `CONTENT_REWARD_STATE_UNCHANGED` | The action would change nothing |
| `409` | `CONTENT_REWARD_ARCHIVED` | Switching a removed reward off or on. Restore it first. |
| `409` | `CONTENT_REWARD_NOT_MODERATED` | Undoing something the artist did themselves |
| `409` | `CONTENT_REWARD_MODERATION_LOCKED` | *(Artist panel)* Trying to switch on or restore a reward HitBox locked |

---

## 8. Setup

- Migration `20261103120000_reward_moderation` adds
  `ContentBundle.moderationLockedAt`, `moderationReason` and
  `moderatedById` (not a foreign key; the record outlives the account).
- Run `pnpm db:deploy` and `pnpm db:seed:audit` once per environment. The
  seed registers the four `content.reward.*` events.
- No new permissions: `content-unlock:manage:global` is already granted to
  System Admin and Content Manager.

---

## 9. Console checklist

- [ ] **Rewards** page: tiles from `GET /admin/rewards/summary`; a table from `GET /admin/rewards` with filters for status (incl. "Locked by HitBox"), artist and search.
- [ ] Row → **detail**: name, artist, collection, status badge, a lock banner with reason, a file gallery (play or preview from `items[].url`), "Requires N drops".
- [ ] **Unlocks** tab: `GET …/unlocks` with a LIVE / ENDED filter, showing handle, unlocked at, times opened and last opened.
- [ ] **History** tab: `GET /admin/audit/events?resourceType=ContentBundle&resourceId=<id>`.
- [ ] Actions:
  - **Switch off** / **Remove**: confirm, with a required "Reason (shown to the artist)" box.
  - **Switch on** / **Restore**: shown only when `moderation.locked`.
  - Show `409` messages as returned.
- [ ] Show the page only to callers with `content-unlock:manage:global` (from `/authz/me`).
- [ ] Artist panel: the moderation banner from 5.

---

## 10. Code map

```
packages/content/
  prisma/content.prisma                       ContentBundle.moderationLockedAt / moderationReason / moderatedById
  src/constants/content.constant.ts           REWARD_ADMIN_CAPABILITY, audit events, error codes
  src/domain/content-audit.port.ts            IContentAuditRecorder — bootstrap passes the real recorder
  src/repository/content.repository.ts        adminList, adminCounts, topByUnlocks, listUnlocks, liveGrantCounts
  src/service/admin-reward.service.ts         monitoring + the moderation lock
  src/service/collection-reward.service.ts    the artist can't lift the lock (save)
  src/controller/admin-reward.controller.ts   request schemas + handlers
  src/module.ts                               createAdminRouter — /admin/rewards
  tests/admin-rewards.test.ts
packages/audit/src/domain/audit-event-catalog.ts   content.reward.*
apps/backend/src/bootstrap.ts, routes.ts           wiring
```
