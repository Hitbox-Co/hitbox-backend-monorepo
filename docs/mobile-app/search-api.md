# Search — API

The app's one search box: **products, artists and other collectors** in a
single call.

| Screen block | Source |
|---|---|
| Search bar, as-you-type overview (three short sections) | `GET /search?q=` |
| "See all" on the Products section | `GET /search?q=&type=products&page=` |
| "See all" on the Artists section | `GET /search?q=&type=artists&page=` |
| "See all" on the People section | `GET /search?q=&type=users&page=` |

Base path: `/api/v1/search`. Code: `packages/search` (route, DTOs, service, the
`IUserSearch` port), `packages/users` (the collector lookup) and
`packages/products` (drops and artists, through discover's `IProductDiscovery`
port).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/search` | optional | Products, artists and collectors that match the text |

---

## Authentication

Public. Sending the usual Clerk session (`Authorization: Bearer <token>`) is
optional and does two things:

| Request | Effect |
|---|---|
| No token | `isWishlisted` is `null` on every product; collectors are not filtered |
| Valid token | `isWishlisted` is `true` / `false`; **you are left out of the People results** |
| Expired or invalid token | Served as a guest, **never a 401** |

See [auth-api.md](auth-api.md).

---

## `GET /api/v1/search`

| Param | Values | Default |
|---|---|---|
| `q` | **required**, 1–100 characters after trimming. A leading `@` is ignored, so `@mia` and `mia` find the same people | none |
| `type` | `all` `products` `artists` `users` | `all` |
| `page` | int ≥ 1. Only used with a single `type`; `all` always returns page 1 | `1` |
| `limit` | int ≥ 1. With `type=all` it is the size of **each section**, capped at **20** (default **5**). With a single type, capped at **50** (default **20**) | see left |
| `marketId` | uuid of a market from `GET /markets`. Prices are shown for this market, else the default market. A bad or unknown value is ignored, never an error | none |

### What matches

Matching is **case-insensitive "contains"**, with no ranking or typo tolerance.

| Section | Matches on | Only includes |
|---|---|---|
| `products` | the drop's `name` | public drops (`status = ACTIVE`, active, not archived), the same rule as [Discover](discover-api.md#step-1-is-the-drop-public). Newest first |
| `artists` | the artist's `name` or `slug` (handle) | public, active, non-archived artists **with at least one public drop**. Most drops first, then name A–Z |
| `users` | the collector's `handle` or `fullName` | active, non-deleted accounts. **Private profiles are included** (see `isPrivate`). The signed-in user is excluded. Name A–Z |

### Response: `type=all`

The overview. Every section is present, each with its first `limit` items and
the full `total` for a "See all 42" link. There is **no `meta`**.

```jsonc
{
  "data": {
    "query": "nova",                 // the text actually searched (trimmed, "@" removed)
    "type": "all",
    "page": 1,
    "limit": 5,                      // page size of each section
    "products": {
      "items": [ DiscoverProductItem, … ],
      "total": 12
    },
    "artists": {
      "items": [ DiscoverCreatorItem, … ],
      "total": 1
    },
    "users": {
      "items": [ SearchUserItem, … ],
      "total": 3
    }
  }
}
```

### Response: a single `type`

Only the requested section is filled; the other two are `null`. A paginated
`meta` is added, with the usual shape.

```jsonc
// GET /search?q=nova&type=artists&page=1&limit=20
{
  "data": {
    "query": "nova",
    "type": "artists",
    "page": 1,
    "limit": 20,
    "products": null,
    "artists": { "items": [ DiscoverCreatorItem, … ], "total": 1 },
    "users": null
  },
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

## Shapes

### `DiscoverProductItem`: a drop card

The same card Discover and the Marketplace use. Tapping it opens
`GET /products/:id`. Field list and meaning: see
[discover-api.md](discover-api.md#discoverproductitem-one-drop-card).

### `DiscoverCreatorItem`: an artist row

```jsonc
{
  "id": "a91e…",                     // GET /follows/artists/:artistId to follow
  "name": "Studio Nova",
  "slug": "studio-nova",
  "avatarUrl": "https://…",          // null if none
  "coverUrl": "https://…",           // null if none
  "dropCount": 12                    // publicly visible drops
}
```

### `SearchUserItem`: a collector row

```jsonc
{
  "id": "9b1d7e3a-…",                // GET /users/:id for the profile
  "handle": "mia.figures",           // null if the user never set one
  "fullName": "Mia Lopez",           // null if none
  "avatarUrl": "https://img.clerk.com/…",
  "isPrivate": true                  // private profile: tapping shows name + stats, no items
}
```

There is no email, phone, location or bio in a search result, and no follow
state. To draw a Follow button, call `GET /follows/users/:userId/followers` or
the profile endpoint's `viewer.isFollowing`
([users-api.md](users-api.md)); to follow, use [follows-api.md](follows-api.md).

---

## Walkthrough

| User does | Call |
|---|---|
| Types `nova` in the search bar | `GET /search?q=nova` → three short sections |
| Taps **See all** under Products | `GET /search?q=nova&type=products` |
| Scrolls to the end of that list | `GET /search?q=nova&type=products&page=2` |
| Taps a product card | `GET /products/:id` |
| Taps an artist | the artist profile screen, with `artist.id` |
| Taps a collector | `GET /users/:id` |
| Types `@mia` | `GET /search?q=%40mia` (encode the `@`) → collectors named or handled "mia" |

Debounce the input (about 300 ms) and ignore a response whose `query` no longer
matches the box.

---

## Errors

| Status | Code | When |
|---|---|---|
| 422 | `VALIDATION_ERROR` | `q` is missing, blank or over 100 characters; unknown `type`; `page` or `limit` is not a positive integer |
| 429 | `RATE_LIMITED` | More than **60 searches per minute per IP**, on top of the global limit |

Search defines no error codes of its own. A text with no matches is **not** an
error: it returns `200` with empty `items` and `total: 0` in each section. See
the shared error format in [README.md](README.md#errors).

---

## Known limitations

- **Contains-match only.** No ranking, no typo tolerance, no search on
  descriptions, tags, categories or genres. Results are ordered per section,
  not by how well they match.
- **Artists with no public drop do not appear**, even though their profile is
  public. The artist list reuses the Discover creators rule.
- **Collectors have no relevance order**, only A–Z by full name.
- **One market for prices.** Product prices follow `marketId` (or the default
  market); a drop not priced in the chosen market is hidden when `marketId` is
  sent, as in Discover.
- **No search history or suggestions** are stored or served.
