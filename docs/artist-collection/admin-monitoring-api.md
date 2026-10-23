# Artist collections — monitoring API (HitBox System Admin)

> Read-only oversight of every artist's collections for the admin console:
> who has created what, what's public, what's empty, what was deleted.
> Background: [README.md](README.md). The artist-side API:
> [artist-collection-api.md](artist-collection-api.md).

Base path **`/api/v1/admin/artist-collections`**, Clerk session required.

**Access:** `brand-artist-record:read` at **global** scope. HITBOX_SYSTEM_ADMIN
holds `brand-artist-record:manage:global`, which satisfies it. An
organization-scoped holder (Brand Admin) is refused `403` — these routes are
platform-wide only (`globalOnly`). Use `GET /authz/me` and look for
`brand-artist-record:manage:global` (or `…:read:global`) to decide whether to
show the menu item.

| Method & path | What it returns |
|---|---|
| `GET /admin/artist-collections` | Paginated list with filters |
| `GET /admin/artist-collections/summary` | Headline numbers for the tiles |
| `GET /admin/artist-collections/:collectionId` | One collection, with its drops |

Nothing here writes. There is no admin edit, hide or delete yet — see
[README §7](README.md#7-known-gaps).

---

## `GET /admin/artist-collections`

| Query | Values | Notes |
|---|---|---|
| `status` | `all` (default), `live`, `archived` | |
| `artistId` | uuid | One artist's collections |
| `organizationId` | uuid | Collections of one organization's artists |
| `isPublic` | `true` / `false` | On the storefront or draft |
| `empty` | `true` / `false` | `true` = no live drops (abandoned or not started) |
| `q` | text | Case-insensitive match on name or slug |
| `createdFrom`, `createdTo` | ISO dates | `createdAt` range, end exclusive |
| `sort` | `newest` (default), `oldest`, `updated`, `name` | |
| `page`, `limit` | default 1, 20; `limit` ≤ 100 | |

```json
{
  "page": 1,
  "limit": 20,
  "total": 3,
  "items": [
    {
      "id": "8e02…",
      "publicCode": "acl0…",
      "name": "Kaze — Season One",
      "slug": "kaze-season-one",
      "description": null,
      "heroImageUrl": null,
      "position": 0,
      "isPublic": true,
      "isActive": true,
      "archivedAt": null,
      "status": "LIVE",
      "counts": { "drops": 4, "liveDrops": 4 },
      "createdAt": "2026-09-01T12:00:00.000Z",
      "updatedAt": "2026-09-01T12:00:00.000Z",
      "artist": { "id": "23ef…", "name": "Kaze", "slug": "kaze", "isActive": true, "archived": false },
      "organization": { "id": "4b10…", "name": "Kaze (solo)" }
    }
  ]
}
```

`artist.isActive` / `artist.archived` flag collections whose owner has been
deactivated or archived — they stay listed here but the artist can no longer
change them.

## `GET /admin/artist-collections/summary`

```json
{
  "data": {
    "total": 4,
    "live": 3,
    "archived": 1,
    "public": 3,
    "private": 0,
    "empty": 0,
    "createdLast30Days": 1,
    "artistsWithCollections": 3,
    "topArtists": [
      { "artistId": "18562582-…", "name": "Lumen", "liveCollections": 1 }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `total` | Every collection ever created, archived included |
| `live` / `archived` | Split of `total` |
| `public` / `private` | Split of **live** collections by `isPublic` |
| `empty` | Live collections with no live drops |
| `createdLast30Days` | Created in the last 30 days, archived or not |
| `artistsWithCollections` | Artists with at least one live collection |
| `topArtists` | Up to 10 artists by live-collection count |

Suggested tiles: **Live · Public · Drafts (`private`) · Empty · Archived ·
New this month**, each linking to the list with the matching filter
(`empty=true`, `isPublic=false`, `status=archived`,
`createdFrom={30 days ago}`).

## `GET /admin/artist-collections/:collectionId`

The list item shape plus the drops filed under it (newest first, at most 100):

```json
{
  "data": {
    "id": "8e02…",
    "name": "Kaze — Season One",
    "…": "…every field from the list item…",
    "drops": [
      { "id": "d1a0…", "name": "Neon Nights Tee", "status": "DRAFT", "archivedAt": null, "createdAt": "2026-09-02T12:00:00.000Z" }
    ]
  }
}
```

Link each drop to the catalog (`/admin/products/:id`).

## Errors

| Status | Code | When |
|---|---|---|
| `403` | `AUTHZ_FORBIDDEN` | No platform-wide `brand-artist-record` read |
| `404` | `ARTIST_COLLECTION_NOT_FOUND` | No such collection |
| `422` | `VALIDATION_ERROR` | Bad query (e.g. `limit=500`, non-uuid `artistId`) |

## Frontend checklist

- [ ] Menu item visible only with `brand-artist-record:manage:global` / `…:read:global` in `GET /authz/me`.
- [ ] Summary tiles from `/summary`, each a pre-filtered link into the list.
- [ ] Table: name + slug, artist (link to `?artistId=`), organization, status chip (Live / Archived), visibility chip (Public / Draft), `counts.liveDrops`, created, updated.
- [ ] Filters: status, visibility, empty, organization, date range, search box (`q`), sort.
- [ ] Badge rows whose `artist.isActive` is `false` or `artist.archived` is `true`.
- [ ] Detail drawer from `/:collectionId` with the drops list.
