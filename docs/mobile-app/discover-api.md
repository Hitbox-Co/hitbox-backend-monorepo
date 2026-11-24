# Discover screen — API

The mobile **Discover** tab, top to bottom, and the API that feeds it.

| Screen block | Source |
|---|---|
| Hero carousel ("Beyond the ordinary.", price, **Buy Now**) | `GET /discover` → `featured` |
| Leaderboard banner | **out of scope** — not served by this module |
| Category chips (All Items · Cards · Figures · Apparel · …) | `?category=` on `GET /discover` and `GET /discover/products` |
| **Trending now** + "View all" | `featured`/`trending` → `GET /discover/products?section=trending` |
| **Meet the creators** + "Explore" | `creators` → `GET /discover/creators` |
| **Latest drops** + "View all" | `newReleases` → `GET /discover/products?section=new_releases` |
| Search bar | `GET /discover/products?search=` |

Base path: `/api/v1/discover`. Code: `packages/discover` (routes, DTOs, the
`IProductDiscovery` port) and `packages/products/src/domain/product-discovery.adapter.ts`
(the queries).

---

## Authentication

All three endpoints are **public**. Sending the usual Clerk session
(`Authorization: Bearer <token>`) is optional and only
adds personalisation:

| Request | `isWishlisted` on every card |
|---|---|
| No token | `null` |
| Valid token | `true` / `false` |
| Expired / invalid token, unknown or suspended account | `null` — served as a guest, **never a 401** |

`GET /discover/creators` has nothing per-user and ignores the token.

The heart's state comes from `WishlistItem`: a drop counts as wishlisted if the
user wishlisted it with any variant. To toggle it, use `POST /wishlist` (on) and
`DELETE /wishlist/products/:productId` (off). See [wishlist-api.md](wishlist-api.md).

---

## Shapes

### `DiscoverProductItem`: one drop card

The same shape is used by the hero, Trending now, Latest drops, "View all" and search.

```jsonc
{
  "id": "6f1c…",                          // Drop id → GET /api/v1/products/:id on tap
  "name": "Cosmic Voyager #001",
  "description": "Beyond the ordinary.",  // hero tagline; null if not set
  "imageUrl": "https://…",                // primary image; null if none
  "rarity": "ULTRA_RARE",                 // Drop.rarity as stored; null if not set
  "category": "FIGURE",                   // Drop.category as stored; null if not set
  "artist": {                             // drop's artist, else its collection's artist
    "id": "a91e…", "name": "STUDIO NOVA", "slug": "studio-nova"
  },
  "price": {                              // base price of ?marketId (that market only), else the default market; null if none
    "amount": "480.00",                   // decimal string, "0" when free
    "currency": "USD",
    "isFree": false,
    "marketId": "7c1d…"                    // the market this price is in
  },
  "totalSupply": 200,                     // "Edition of 200"
  "mintedCount": 42,                      // "042 / 100" = mintedCount / totalSupply
  "rewardPoints": 2400,                   // "★ 2,400 pts"; 0 when none set
  "isWishlisted": false                   // heart; null for guests
}
```

How the design maps onto the fields:

| On screen | Field / formatting |
|---|---|
| `ULTRA RARE`, `RARE`, `UNCOMMON` badge | `rarity`: replace `_` with a space and uppercase it. Hide the badge when `null`. |
| `by STUDIO NOVA` / `STUDIO NOVA` | `artist.name` |
| `$480.00`, `$185` | `price.amount` + `price.currency`. Hide when `price` is `null`. |
| `Edition of 200` | `totalSupply` |
| `042 / 100` | `mintedCount` zero-padded / `totalSupply` |
| `★ 935 pts` | `rewardPoints` |
| ♡ / ♥ | `isWishlisted` (hidden or outlined when `null`) |

`rarity` and `category` are free-form columns, so their values are whatever the
admin entered. The client should format them for display and never switch on
them as a fixed enum.

### `DiscoverCreatorItem`: one "Meet the creators" entry

```jsonc
{
  "id": "a91e…",
  "name": "Studio Nova",
  "slug": "studio-nova",
  "avatarUrl": "https://…",   // round avatar; null if none
  "coverUrl": "https://…",    // banner (the large image above the row); null if none
  "dropCount": 12             // "12 drops" — public drops only
}
```

The large banner image is the first creator's `coverUrl`.

---

## Endpoints

### `GET /api/v1/discover`

The whole screen in **one round-trip**. The sections are queried in parallel.

| Param | Values | Default |
|---|---|---|
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | none (All Items) |
| `marketId` | uuid of a market from `GET /markets` | none: unfiltered, default market's price. With one: only drops priced there. See [Market selection](#market-selection) |

`category` narrows the three drop sections. `creators` is the same for every chip.

```jsonc
{
  "data": {
    "featured":    [ DiscoverProductItem × ≤5 ],   // hero carousel
    "trending":    [ DiscoverProductItem × ≤10 ],  // Trending now
    "creators":    [ DiscoverCreatorItem × ≤10 ],  // Meet the creators
    "newReleases": [ DiscoverProductItem × ≤10 ]   // Latest drops
  }
}
```

**`featured` is never empty while any public drop exists** in the selected
category. When fewer than 5 drops sit in the top rarity tiers, it is topped up
with `trending` drops (in trending order, no duplicates). The other lists can be
empty, for example in an empty category or a fresh database. The client should
hide a section whose list is empty.

### `GET /api/v1/discover/products`

A paginated drop list. It backs "View all" on each section and the search bar.

| Param | Values | Default |
|---|---|---|
| `section` | `featured` `trending` `new_releases` | none (all public drops, newest first) |

`section=featured` returns only the top-rarity drops. The trending top-up applies
to the `GET /discover` hero only, because a padded list cannot be paginated
consistently.
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | none |
| `search` | 1–100 chars, case-insensitive match on name | none |
| `marketId` | uuid of a market from `GET /markets` | none: unfiltered, default market's price. With one: only drops priced there. See [Market selection](#market-selection) |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ DiscoverProductItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

### `GET /api/v1/discover/creators`

A paginated creator list. It backs "Explore" next to **Meet the creators**.

| Param | Values | Default |
|---|---|---|
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ DiscoverCreatorItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 6, "totalPages": 1 }
}
```

### Errors

A bad query parameter, such as an unknown `section` or `category` or `limit=500`,
returns **422 `VALIDATION_ERROR`**. Discover defines no error codes of its own.
See the shared error format in [README.md](README.md#errors).

---

## How each list is chosen

Every drop list is built in the same three steps: decide which drops are
public, apply the section's filters, then sort and take the first N.

### Step 1: is the drop public?

A drop can appear anywhere on this screen only when **all three** are true:

| Condition | Why |
|---|---|
| `status = ACTIVE` | The drop is live. `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `PUBLISHED`, `ENDED` and `ARCHIVED` are all hidden. |
| `isActive = true` | The admin kill switch is off. |
| `archivedAt = null` | The drop is not soft-deleted. |

Note that `PUBLISHED` is **not** enough on its own. A drop shows up only once
its status reaches `ACTIVE`.

### Step 2: section filters

These apply on top of step 1.

| Filter | Applies to | Condition |
|---|---|---|
| Category chip (`?category=`) | `featured`, `trending`, `newReleases` | `Drop.category` is in the chip's list (table below). "All Items" = no filter. |
| Search (`?search=`) | `/discover/products` only | `name` contains the text, case-insensitive |
| Top rarity | `featured` only | `rarity` is one of `LEGENDARY`, `MYTHIC`, `ULTRA_RARE`, `ULTRA RARE`, `EPIC` (case-insensitive) |

### Step 3: order and limit

"Minted SKUs" is the number of physical units (`Sku` rows) created for the drop.
The schema has no sales or view counts, so this is the popularity signal.

| List | Order | Limit in `GET /discover` |
|---|---|---|
| `trending` | most minted SKUs first; ties → newest `createdAt` first | 10 |
| `featured` | same as trending | 5 |
| `newReleases` | newest `createdAt` first | 10 |
| `creators` | most drops first; ties → name A–Z | 10 |

### The `featured` fallback (never empty)

1. Take the public drops in the top rarity tiers (steps 1–3).
2. If that gives **5 or more**, the hero is those 5.
3. If it gives **fewer than 5**, fill the remaining slots from `trending`
   (same category), in trending order, skipping drops already in the hero.

So the hero is empty only when the selected category has **no public drop at
all**, in which case `trending` and `newReleases` are empty too.

The fallback applies to `GET /discover` only. `GET /discover/products?section=featured`
returns just the top-rarity drops, because a padded list cannot be paginated
consistently.

### `creators`

An artist is listed when **all** are true: `isPublic = true`, `isActive = true`,
`archivedAt = null`, and the artist has **at least one public drop** (step 1).
`dropCount` counts public drops only. The sort counts all of the artist's drops,
because Prisma cannot filter a relation count inside `orderBy`.

### Category chips → `Drop.category`

This mapping is shared with Marketplace in
`packages/products/src/domain/storage-categories.ts`:

| Chip | `Drop.category` values |
|---|---|
| `cards` | `TRADING_CARD`, `CARD_PACK` |
| `figures` | `FIGURE` |
| `apparel` | `APPAREL`, `JERSEY`, `ACCESSORY` |
| `posters` | `POSTER` |
| `digital` | `DIGITAL_ASSET` |
| `other` | `BOOK`, `AUTOGRAPH`, `GAME_BOX`, `OTHER` |

A drop whose category is in no list (or is `null`) appears only under **All Items**.

### Worked example (database as of 2026-11-18)

13 drops exist. Only **5** pass step 1:

| Drop | Status | Rarity | Category | Minted | Public? |
|---|---|---|---|---|---|
| Kaze — Neon Nights Tour Tee | ACTIVE | COMMON | APPAREL | 48 | yes |
| Kaze Genesis — Single Card | ACTIVE | RARE | TRADING_CARD | 40 | yes |
| Ronin Crest Snapback | ACTIVE | COMMON | APPAREL | 30 | yes |
| Lumen Orbit Keychain | ACTIVE | COMMON | ACCESSORY | 30 | yes |
| HitBox Classic Logo Tee | ACTIVE | COMMON | APPAREL | 18 | yes |
| Ronin Rookie — Single Card | **PUBLISHED** | LEGENDARY | TRADING_CARD | 25 | no, not ACTIVE |
| Lumen Afterglow Tee | **ENDED** | RARE | APPAREL | 8 | no |
| the other 6 | DRAFT / SUBMITTED / APPROVED / REJECTED | | | | no |

The result is:

- **Top-rarity drops:** none. The only `LEGENDARY` drop is `PUBLISHED`, not
  `ACTIVE`. Without the fallback, the hero would be empty.
- **`featured`:** all 5 come from the fallback, in trending order: Neon Nights
  Tour Tee (48), Genesis Single Card (40), then Crest Snapback and Orbit Keychain
  (30 each, whichever was created more recently comes first), then Classic Logo
  Tee (18).
- **`trending`:** the same 5, in the same order.
- **`?category=cards`:** each list contains only the Kaze Genesis card.

When "Ronin Rookie — Single Card" moves to `ACTIVE`, it becomes the first hero
slot: it is the only top-rarity public drop, and the fallback fills the other 4.

### Caching

Drop and creator lists are cached in the products list cache (`discover` and
`discover-creators` namespaces), so a newly published drop or an edited artist
avatar can take up to one cache TTL to show up. `isWishlisted` is **not** cached.
It is looked up for each request after the cached rows are read.

---

## Market selection

Send the buyer's market on this route as **`?marketId=<uuid>`** (an id from
`GET /markets`). It is the *region*: the app sends the same id on every screen and
to `/checkout/quote` and `/checkout`.

- **Only drops priced in that market are listed.** A drop with no active base
  price in the selected market is left out, and `meta.total` and paging count only
  the drops that remain. Changing the market changes the list and every price.
- Each card's `price` is that market's price (`amount`, `currency`, `isFree`), and
  `price.marketId` is the selected market.
- **No `marketId`**, or one that is not a uuid, unknown or an inactive market:
  **ignored, never an error.** The list is unfiltered and shows the default
  market's price, exactly as before.
- Sorting, filters, paging and caching headers are unchanged.
- Counts and sections follow the filter: for example, `featured` can hold fewer
  than 10 cards in a market where fewer featured drops are sold.

## Known limitations

- **"Trending" means most minted.** There are no sales or view counters to rank by.
  The hero uses the same ordering, limited to the top rarity tiers.
- **The hero has no editorial curation.** The schema has no "featured" flag, and
  the tagline is `Drop.description`.
- **Creator ordering counts all drops.** Prisma cannot filter a relation count
  inside `orderBy`, so creators are sorted by total drops, while `dropCount` shows
  public drops only.

## Changes from the previous version

The previous shape was `featured` / `trending` / `newReleases` / `topCreators`,
with cards containing only `id`, `name`, `imageUrl` and `rewardPoints`.

- Cards now also carry `description`, `rarity`, `category`, `artist`, `price`,
  `totalSupply`, `mintedCount` and `isWishlisted`.
- `topCreators`, a drop list sorted the same way as `trending`, is replaced by
  `creators`, a real artist list. The `top_creators` section value is removed.
- New: the `category` filter, `section=featured`, and `GET /discover/creators`.
