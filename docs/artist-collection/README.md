# Artist collections

> An **artist collection** is a curated series of drops by one artist —
> "Kaze — Season One" — and the unit a buyer tries to complete. Artists
> create, edit, reorder, delete and restore their own collections from the
> artist dashboard; HitBox System Admins monitor every artist's collections.
> Every change is audited.

| Document | For |
|---|---|
| [artist-collection-api.md](artist-collection-api.md) | **Artist dashboard** — every route under `/api/v1/artist/collections`, request/response shapes, errors, the screens and a frontend checklist |
| [admin-monitoring-api.md](admin-monitoring-api.md) | **Admin console** — `/api/v1/admin/artist-collections`: the monitoring list, filters, summary tiles, detail and the audit trail |
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
| `isActive` | server | `false` while archived |
| `archivedAt` | server | Set by delete, cleared by restore. Archived = read-only |

Drops join a collection through `Drop.collectionId`. Claims, content bundles,
evolution rules, royalty rules and media assets also reference it.

---

## 2. Who can do what

No new permission was added. A collection is part of the artist's record, so
it uses the existing `brand-artist-record` capability — checked by
capability, never by role name:

| Caller | Grant that lets them in | Can |
|---|---|---|
| **Artist** (`ARTIST` role) | `brand-artist-record:read:own`, `brand-artist-record:update:own` — checked against the caller's own account | List, create, read, edit, reorder, delete and restore **their own** collections; set the hero image |
| **HitBox System Admin** | `brand-artist-record:manage:global` (implies read), route is `globalOnly` | Monitor **every** artist's collections: list, filter, search, summary, detail — and read their audit trail (`audit-log:read:global`). Read-only |
| Brand Admin | `brand-artist-record:*:organization` | **Neither surface** — own-scope routes don't accept an organization grant, and the monitoring routes are platform-wide only |
| Drop managers (products) | `drop:manage:*` | File a drop under a collection — only one of the drop's own artist (§3) |
| Buyer / anyone else | — | `403` |

"Which artist" is never a parameter on the artist side: it is always the
profile linked to the signed-in account (`Artist.userId`). Another artist's
collection id is answered with `404`, not `403`, so ids can't be probed.

---

## 3. The rules

### Which drops can be in a collection — enforced by products

A drop may only be filed under a collection that is **live** and belongs to
**the drop's own artist** (`Drop.artistId` = `ArtistCollection.artistId`). A
drop with no artist can't be in a collection. Products checks this on create,
and on update whenever `collectionId` or `artistId` changes:

| Error | When |
|---|---|
| `400 PRODUCTS_COLLECTION_NOT_FOUND` | no such collection |
| `400 PRODUCTS_COLLECTION_ARCHIVED` | the artist deleted it |
| `400 PRODUCTS_COLLECTION_ARTIST_MISMATCH` | another artist's collection, or the drop has no artist. `details: { collectionArtistId, dropArtistId }` |

Moving a drop to another artist means sending both `artistId` and
`collectionId` in one request. An unrelated edit doesn't re-check an existing
pairing. Every drop in the live data already matched when the rule went in.
Details: [admin/product-upload-api.md](../admin/product-upload-api.md).

### Which drops the artist is shown — active and their own

Inside a collection the artist sees only drops that are:

- **active** — `status: ACTIVE`, `isActive: true`, not archived. This is
  exactly the public catalog's definition (products' `PUBLIC_PRODUCT_WHERE`,
  mirrored as `ACTIVE_DROP_WHERE` in the artist module — change both
  together); and
- **their own** — `Drop.artistId` is the collection's artist.

Drafts, drops in review, approved-not-live, ended and rejected drops are not
shown. `GET /artist/collections/:id` lists the shown drops; every view
carries `counts.activeDrops`. Monitoring sees every drop, each flagged
`shownToArtist` and `sameArtist`.

### Delete is an archive, and it refuses while drops remain

`DELETE /artist/collections/:id` sets `archivedAt`, `isActive: false` and
`isPublic: false`. The row is **never** removed: drops, claims, content,
evolution and royalty rules hold foreign keys to it, and a buyer's
collection-progress history has to keep resolving.

It is refused (`409 ARTIST_COLLECTION_HAS_DROPS`, `details.liveDrops`) while
the collection still holds any drop that isn't archived — **in any status**,
including drafts the artist isn't shown. Those would otherwise be stranded in
a deleted collection. So `counts.liveDrops` (blocks delete) can be higher
than `counts.activeDrops` (shown); Kaze — Season One holds 4 drops of which 2
are active. The artist can't move drops themselves, so they're told to ask
their brand team or HitBox. `actions.archiveBlockedReason` says this up front.

An archived collection can't be edited (`409 ARTIST_COLLECTION_ARCHIVED`),
keeps its slug, and frees its **name** for reuse.

### Restore

`POST /artist/collections/:id/restore` undoes a delete. The collection comes
back:

- **live** (`archivedAt` cleared, `isActive: true`);
- **private** (`isPublic: false`), whatever it was before — the storefront
  only changes when the artist republishes;
- at the **end** of the list;
- with its **slug** (held while archived), and its **name** — unless that has
  since been reused by another live collection, in which case it's refused
  (`409 ARTIST_COLLECTION_NAME_TAKEN`) and the artist resends with
  `{ "name": "…" }`.

It counts toward the 50-collection limit, and only archived collections can
be restored (`409 ARTIST_COLLECTION_NOT_ARCHIVED`).

### Order

New and restored collections go last. `PUT /artist/collections/order` takes
the **whole** live list in its new order — not one item's new position — so
two tabs racing can't leave two collections at the same position. Deleting
closes the gap.

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
indexing). Payloads carry ids, not data. Separate from the audit trail (§6):
events are for reacting, the audit trail is the record.

| Event | Payload |
|---|---|
| `artist.collection.created` | `{ collectionId, artistId }` |
| `artist.collection.updated` | `{ collectionId, artistId, fields }` |
| `artist.collection.archived` | `{ collectionId, artistId }` |
| `artist.collection.restored` | `{ collectionId, artistId }` |
| `artist.collection.reordered` | `{ artistId, collectionIds }` |

---

## 6. Audit trail

Every change an artist makes to a collection is written to the platform audit
log through the **artist module's audit hook** — its own port,
`IArtistAuditRecorder` (`packages/artist/src/domain/interfaces/audit-recorder.port.ts`),
implemented by `@hitbox/audit`'s recorder and connected in bootstrap. The
module refuses to build its routers without it, so a write surface can't be
started without its trail.

| Audit event | Severity | When | `resource` |
|---|---|---|---|
| `artist.collection.create` | INFO | created | `ArtistCollection` |
| `artist.collection.update` | INFO | name, slug, description, visibility **or hero image** changed | `ArtistCollection` |
| `artist.collection.archive` | WARNING | deleted — it leaves the storefront | `ArtistCollection` |
| `artist.collection.restore` | INFO | restored | `ArtistCollection` |
| `artist.collection.reorder` | INFO | the list's order changed | `Artist` (the whole list) |

Each row records:

- `actorType: ARTIST`, `actorId` = the artist's user account;
- `organizationId` = the collection's organization;
- `beforeState` / `afterState` — `name`, `slug`, `description`,
  `heroImageUrl`, `position`, `isPublic`, `isActive`, `archivedAt` (for a
  reorder: `{ order: [ids] }` before and after); `beforeState` is null on create;
- `metadata` — `artistId`, `fields` changed, and `assetId` when a hero image
  was set.

Successful changes are recorded, straight after the write — the same pattern
as orders and payments. A refused request (validation, conflict, permission)
writes nothing here. The event types are registered in `AUDIT_EVENT_CATALOG` and seeded with
`pnpm db:seed:audit`.

**Reading it** (System Admin, `audit-log:read:global`):

```http
GET /api/v1/admin/audit/events?resourceType=ArtistCollection&resourceId={collectionId}
GET /api/v1/admin/audit/events?eventType=artist.collection.archive
GET /api/v1/admin/audit/events?actorId={artistUserId}
```

Full reference: [audit/audit-logging.md](../audit/audit-logging.md).

---

## 7. Where the code lives

```
packages/artist/src/
  domain/interfaces/audit-recorder.port.ts   the module's audit hook (IArtistAuditRecorder)
  collection/
    constants/artist-collection.constant.ts  capabilities, error codes, ACTIVE_DROP_WHERE,
                                             audit event types, bus events, limits
    dto/artist-collection.dto.ts             request schemas (strict) + response shapes
    repository/artist-collection.repository.ts the only Prisma access
    service/artist-collection.service.ts     the rules above, audit calls, monitoring
    controller/artist-collection.controller.ts artist + admin controllers
  module.ts                                  routes; requires `audit` to build routers
packages/products/src/service/product.service.ts  assertCollectionFits() — the filing rule
packages/audit/src/domain/audit-event-catalog.ts  artist.collection.* registered
apps/backend/src/bootstrap.ts                audit hook wired (deferred, like orders)
apps/backend/src/routes.ts                   /admin/artist-collections

packages/artist/tests/artist-collection.test.ts   artist rules, restore, shown drops, audit
packages/products/tests/collection-fit.test.ts    the filing rule
```

---

## 8. Known gaps

- **No admin moderation.** Monitoring is read-only; HitBox can't hide or
  unpublish someone else's collection from these routes. That would be a new
  `brand-artist-record:manage` write route (and a new audit event).
- **No collection picker for non-admin drop managers.** The products filing
  rule is enforced, but the only endpoint that lists an artist's collections
  for a picker is the System Admin monitoring list.
- **Artist profile edits are not audited** — only collection changes go
  through the new hook. Wiring `/artist/me` into the same port is a small
  follow-up.
