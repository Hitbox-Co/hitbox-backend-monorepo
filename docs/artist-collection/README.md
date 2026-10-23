# Artist collections

> An **artist collection** is a curated series of drops by one artist —
> "Kaze — Season One" — and the unit a buyer tries to complete. Artists now
> create, edit, reorder and delete their own collections from the artist
> dashboard; HitBox System Admins monitor every artist's collections.

| Document | For |
|---|---|
| [artist-collection-api.md](artist-collection-api.md) | **Artist dashboard** — every route under `/api/v1/artist/collections`, request/response shapes, errors, the screens and a frontend checklist |
| [admin-monitoring-api.md](admin-monitoring-api.md) | **Admin console** — `/api/v1/admin/artist-collections`: the monitoring list, filters, summary tiles and detail |
| this file | The model, the rules and why they are shaped the way they are |

All paths are under **`/api/v1`** and need a Clerk session. Single records come
back as `{ "data": {...} }`, lists as `{ "page", "limit", "total", "items" }`
(admin) or `{ "data": [...] }` (the artist's own, unpaginated), errors as
`{ "error": { "code", "message", "details" } }`.

---

## 1. The table

`ArtistCollection` (owned by `@hitbox/artist`, `packages/artist/prisma/artist.prisma`).
No schema change was needed — the table already existed; it simply had no
write API.

| Column | Set by | Notes |
|---|---|---|
| `id`, `publicCode` (`acl…`) | server | |
| `name` | artist | 1–120 chars. Unique per artist among **live** collections, case-insensitive |
| `slug` | artist or server | Globally unique URL handle. Generated as `{artist-slug}-{name}` (`kaze-season-two`), `-2`, `-3`… on a clash |
| `description` | artist | Up to 2000 chars; `""`/`null` clears it |
| `heroImageUrl` | artist, **via the upload flow only** | Never a free-text URL — see §4 |
| `position` | server / reorder route | 0-based order on the artist's page, among their live collections |
| `artistId` | server | The caller's own artist profile. Never from the request |
| `organizationId` | server | Copied from the artist at creation |
| `isPublic` | artist | Shown on the storefront. **Defaults to `false`** — a new collection is a draft |
| `isActive` | server | `false` once archived |
| `archivedAt` | server | Set by delete. Archived = read-only |

Drops join a collection through `Drop.collectionId`. Claims, content bundles,
evolution rules, royalty rules and media assets also reference it.

---

## 2. Who can do what

No new permission was added. A collection is part of the artist's record, so
it uses the existing `brand-artist-record` capability — checked by
capability, never by role name:

| Caller | Grant that lets them in | Can |
|---|---|---|
| **Artist** (`ARTIST` role) | `brand-artist-record:read:own`, `brand-artist-record:update:own` — checked against the caller's own account | List, create, read, edit, reorder, delete **their own** collections; set the hero image |
| **HitBox System Admin** | `brand-artist-record:manage:global` (implies read), route is `globalOnly` | Monitor **every** artist's collections: list, filter, search, summary, detail. Read-only |
| Brand Admin | `brand-artist-record:*:organization` | **Neither surface** — own-scope routes don't accept an organization grant, and the monitoring routes are platform-wide only |
| Buyer / anyone else | — | `403` |

"Which artist" is never a parameter on the artist side: it is always the
profile linked to the signed-in account (`Artist.userId`). Another artist's
collection id is answered with `404`, not `403`, so ids can't be probed.

---

## 3. The rules

### Delete is an archive, and it refuses while live drops remain

`DELETE /artist/collections/:id` sets `archivedAt`, `isActive: false` and
`isPublic: false`. The row is **never** removed: drops, claims, content,
evolution and royalty rules hold foreign keys to it, and a buyer's
collection-progress history has to keep resolving.

It is refused (`409 ARTIST_COLLECTION_HAS_DROPS`, `details.liveDrops`) while
the collection still holds any drop that isn't archived. The artist can't
move drops themselves — which collection a drop belongs to is set on the drop
by its managers (brand team / HitBox Drop Manager) — and archiving a
collection with on-sale drops would hide them from the artist's page while
every drop page still names it. So the artist is told to ask for the drops to
be moved or retired first. The artist view's `actions.archiveBlockedReason`
says this up front so the Delete button can be disabled with a reason.

An archived collection can't be edited (`409 ARTIST_COLLECTION_ARCHIVED`),
keeps its slug (old links stay unique), and frees its **name** for reuse.
There is no restore route yet.

### Order

New collections go last. `PUT /artist/collections/order` takes the **whole**
live list in its new order — not one item's new position — so two tabs racing
can't leave two collections at the same position. Archiving closes the gap.

### Limits

50 live collections per artist (`MAX_LIVE_COLLECTIONS_PER_ARTIST`) — a guard
against runaway clients, not a product rule.

### Locked profiles

An artist whose profile is archived or deactivated can still **read** their
collections but can't change them (`409 ARTIST_PROFILE_LOCKED`), the same lock
as `/artist/me`.

---

## 4. Hero images

Same storage and checks as the profile cover image
([../artist/artist-profile-api.md](../artist/artist-profile-api.md)): a
presigned upload into the artist's `profile-images/artists/{artistId}/`
prefix (publicly readable, so the URL is permanent), then the asset id is
attached. The image must have been uploaded by this artist, be an image, not
be archived and have passed (or skipped) the scan. Storing a URL only from
the upload flow means a collection can't hot-link an arbitrary external
image. No bucket configured → `400 ARTIST_IMAGES_UNAVAILABLE`.

---

## 5. Events

Published on the event bus for whoever wants them (notifications, search
indexing, an activity feed). Payloads carry ids, not data.

| Event | Payload |
|---|---|
| `artist.collection.created` | `{ collectionId, artistId }` |
| `artist.collection.updated` | `{ collectionId, artistId, fields }` |
| `artist.collection.archived` | `{ collectionId, artistId }` |
| `artist.collection.reordered` | `{ artistId, collectionIds }` |

---

## 6. Where the code lives

```
packages/artist/src/collection/
  constants/artist-collection.constant.ts   capabilities, error codes, limits, events
  dto/artist-collection.dto.ts              request schemas (strict) + response shapes
  repository/artist-collection.repository.ts the only Prisma access (+ the existing capacity read)
  service/artist-collection.service.ts      the rules above, artist side and monitoring side
  controller/artist-collection.controller.ts ArtistCollectionController, AdminArtistCollectionController
packages/artist/src/module.ts               routes: /artist/collections* (self router),
                                            createCollectionsAdminRouter()
apps/backend/src/routes.ts                  mounts /admin/artist-collections
packages/artist/tests/artist-collection.test.ts
```

---

## 7. Known gaps

- **Drops can be filed under any collection.** The products module accepts a
  `collectionId` on a drop without checking that the collection belongs to
  the drop's artist or isn't archived. That is the products module's rule to
  add; nothing here prevents it.
- **No restore** for an archived collection, and **no admin moderation**
  (hide / unpublish someone else's collection). Monitoring is read-only by
  design for now; a moderation action would be a new `brand-artist-record:manage`
  write route.
- **Changes are not audited**, only published as events — the artist module
  has no audit port yet (the profile routes aren't audited either).
