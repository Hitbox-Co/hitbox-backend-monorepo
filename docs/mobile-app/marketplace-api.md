# Marketplace — API

The mobile **Marketplace** tab, top to bottom, and the API that feeds it.

| Screen block | Source |
|---|---|
| Title "Marketplace" + subtitle | static text in the app |
| Search bar ("Search listings…") | `GET /marketplace/listings?search=` |
| **Peer-to-Peer Trading** banner ("NEW FEATURE") | static promo in the app, not served by this module (see Known limitations) |
| Category chips (All Items · Cards · Figures · Apparel · …) | `?category=` on both endpoints |
| **Featured Listings** grid | `GET /marketplace` → `featured` |
| "See All >" | `GET /marketplace/listings?featured=true&sort=popular` |

Base path: `/api/v1/marketplace`. Code: `packages/marketplace` (routes, DTOs, the
`IListingCatalog` port), `packages/products/src/domain/marketplace-listing.adapter.ts`
(the queries) and `packages/products/src/domain/drop-card.ts` (the card, shared
with Discover).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/marketplace` | optional | The whole screen: `featured` + `newListings` |
| GET | `/marketplace/listings` | optional | Paginated grid for "See All", category chips and search |

---

## Authentication

Both endpoints are **public**. Sending the Clerk session
(`Authorization: Bearer <token>`) is optional and only fills in the heart:

| Request | `isWishlisted` on every card |
|---|---|
| No token | `null` |
| Valid token | `true` / `false` |
| Expired or invalid token, unknown or suspended account | `null`: served as a guest, **never a 401** |

Toggling the heart is not part of this module. See [auth-api.md](auth-api.md)
for how tokens work.

---

## Shapes

### `MarketplaceListingItem`: one card

This is the **same card as Discover** ([discover-api.md](discover-api.md)). Both are
built by one function on the server, so they cannot differ.

```jsonc
{
  "id": "6f1c…",                          // Drop id → GET /api/v1/products/:id on tap
  "name": "Lucky in Pink",
  "description": null,                    // Drop.description; not shown on this grid
  "imageUrl": "https://…",                // primary image; null if none
  "rarity": "UNCOMMON",                   // Drop.rarity as stored; null if not set
  "category": "FIGURE",                   // Drop.category as stored; null if not set
  "artist": {                             // drop's artist, else its collection's artist
    "id": "a91e…", "name": "Yuki Lab", "slug": "yuki-lab"
  },
  "price": {                              // base price of the default market; null if none
    "amount": "110.00",                   // decimal string, always 2 places; "0" when free
    "currency": "USD",
    "isFree": false
  },
  "totalSupply": 150,                     // "Edition of 150"
  "mintedCount": 9,                       // "009 / 60" = mintedCount / totalSupply
  "rewardPoints": 550,                    // "☆ 550 pts"; 0 when none set
  "isWishlisted": false                   // heart; null for guests
}
```

How the design maps onto the fields:

| On the card | Field / formatting |
|---|---|
| Image | `imageUrl`. Show a placeholder when `null`. |
| ♡ / ♥ | `isWishlisted`. Outlined when `false` or `null`. |
| **Lucky in Pink** | `name` |
| `UNCOMMON`, `RARE` badge | `rarity`: replace `_` with a space and uppercase it. Hide the badge when `null`. |
| `Yuki Lab · Edition of 150` | `artist.name` + `totalSupply` |
| `Form & Co. · 009 / 60` | `artist.name` + `mintedCount` zero-padded to 3 + `totalSupply` |
| `$110`, `$225` | `price.amount` + `price.currency`. Hide when `price` is `null`. Trimming `.00` is a display choice. |
| `☆ 550 pts` | `rewardPoints` |

`rarity` and `category` are free-form columns. Format them for display; do not
switch on them as a fixed enum.

**Which subtitle?** The design shows both "Edition of N" and "N / M". The API
returns both numbers on every card, so the app chooses. A sensible rule is
"Edition of N" while `mintedCount === 0` and "N / M" after that.

---

## Endpoints

### `GET /api/v1/marketplace`

The whole screen in **one round-trip**.

| Param | Values | Default |
|---|---|---|
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | none (All Items) |

`category` narrows **both** lists.

```jsonc
{
  "data": {
    "featured":    [ MarketplaceListingItem × ≤10 ],  // Featured Listings
    "newListings": [ MarketplaceListingItem × ≤10 ]   // newest first; not in this design, free to use
  }
}
```

**`featured` is never empty while the selected category has any public drop.**
See [the Featured fallback](#featured-and-its-fallback).

### `GET /api/v1/marketplace/listings`

A paginated grid. It backs "See All", the category chips and the search bar.

| Param | Values | Default |
|---|---|---|
| `featured` | `true` `false` | `false`. `true` = only drops that qualify as featured (no fallback) |
| `category` | `cards` `figures` `apparel` `posters` `digital` `other` | none |
| `search` | 1–100 chars, case-insensitive match on name | none |
| `sort` | `newest` `popular` | `newest` |
| `page` | int ≥ 1 | `1` |
| `limit` | int 1–50 | `20` |

```jsonc
{
  "data": [ MarketplaceListingItem, … ],
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

Typical calls:

| Screen action | Request |
|---|---|
| "See All" on Featured Listings | `/listings?featured=true&sort=popular` |
| Tap the **Figures** chip, then "See All" | `/listings?featured=true&sort=popular&category=figures` |
| Type in the search bar | `/listings?search=skull` (add `&category=` if a chip is selected) |

`featured` takes only the literal strings `true` and `false`. Anything else
returns 422.

### Card tap → product details

```text
MarketplaceListingItem.id ──▶ GET /api/v1/products/:id
```

This returns the full drop: description, all images, variants and more. See
[products-api.md](products-api.md).

### Errors

A bad query parameter, such as an unknown `category` or `sort`, `featured=yes`
or `limit=500`, returns **422 `VALIDATION_ERROR`**. Marketplace defines no
error codes of its own. See [README.md](README.md#errors).

---

## How it works

Every list is built in three steps: decide which drops are public, apply the
filters, then sort and take a page.

### Step 1: is the drop public?

A drop can appear on this screen only when **all three** are true:

| Condition | Why |
|---|---|
| `status = ACTIVE` | The drop is live. `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `PUBLISHED`, `ENDED` and `ARCHIVED` are hidden. |
| `isActive = true` | The admin kill switch is off. |
| `archivedAt = null` | The drop is not soft-deleted. |

This is the same rule as Discover.

### Step 2: filters

| Filter | Condition |
|---|---|
| Featured (`featured` list, or `?featured=true`) | `releaseStart` is set. The drop has a declared release window. |
| Category chip | `Drop.category` is in the chip's list (table below). "All Items" = no filter. |
| Search | `name` contains the text, ignoring case |

### Step 3: order

"Minted" is the number of physical units (`Sku` rows) created for the drop. The
schema has no sales or view counts, so this is the popularity signal.

| `sort` | Order |
|---|---|
| `popular` | most minted first; ties → newest `createdAt` first |
| `newest` | newest `createdAt` first |

In `GET /marketplace`, `featured` uses `popular` and `newListings` uses `newest`.

### Featured and its fallback

1. Take the public drops with a `releaseStart` (steps 1–3), most minted first,
   up to 10.
2. If that gives **10**, the grid is those 10.
3. If it gives **fewer than 10**, fill the remaining slots with the most popular
   public drops (same category), skipping drops already shown.

So `featured` is empty only when the selected category has **no public drop at
all**. The fallback applies to `GET /marketplace` only. `/listings?featured=true`
returns just the qualifying drops, because a padded list cannot be paginated
consistently.

### Category chips → `Drop.category`

This mapping is shared with Discover, in
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

### Image and price

- `imageUrl` is the drop's primary image. If none is marked primary, it is the
  one with the lowest position. Archived image placements are skipped.
- `price` is the drop's **base price** (no variant) in the **default market**,
  only when that price row is `ACTIVE` and the market is active. Otherwise
  `price` is `null`. There is no market selection on this route.

### Caching

Each list is cached for **30 seconds**, keyed by its filters and page. A newly
activated drop or a price change can take up to that long to show.
`isWishlisted` is **not** cached: it is looked up on every request after the
cached rows are read.

### Worked example (database as of 2026-11-18)

Five drops pass step 1, and all five have a `releaseStart` (2026-07-31):

| Drop | Category | Minted / supply | Created |
|---|---|---|---|
| Kaze — Neon Nights Tour Tee | `APPAREL` | 48 / 48 | Jul 11 |
| Kaze Genesis — Single Card | `TRADING_CARD` | 40 / 40 | Jul 16 |
| Lumen Orbit Keychain | `ACCESSORY` | 30 / 30 | Jul 15 |
| Ronin Crest Snapback | `APPAREL` | 30 / 30 | Jul 13 |
| HitBox Classic Logo Tee | `APPAREL` | 18 / 18 | Jul 20 |

- **`featured`:** Neon Nights Tour Tee (48), Genesis Single Card (40), Orbit
  Keychain (30, created later than the Snapback), Crest Snapback (30), Classic
  Logo Tee (18). All five qualify, so nothing is filled in from the fallback.
- **`newListings`:** Classic Logo Tee, Genesis Single Card, Orbit Keychain,
  Crest Snapback, Neon Nights Tour Tee.
- **`?category=apparel`:** the three `APPAREL` drops and the `ACCESSORY` keychain.
- **`?category=cards`:** Genesis Single Card only.
- **`?category=figures`:** empty, because no public drop has `FIGURE`.
  `featured` is empty too, since there is nothing to fall back on.

---

## Known limitations

- **The Peer-to-Peer banner has no backend.** It is a static promo. There is a
  `ResaleListing` table, but no buyer-facing resale API, so there are no live
  peer listings, bids or countdowns. Every card on this screen is a primary
  drop sold by HitBox.
- **"Featured" is not curated.** It means "has a release window", ordered by
  minted units. The schema has no featured flag.
- **"Popular" means most minted**, not most sold.
- **No price sorting.** Price lives in a per-market table, so it cannot be an
  `ORDER BY` on this list.
- **No market selection.** The price is always the default market's.

## Changes from the previous version

The card used to be `id`, `name`, `imageUrl`, `artistName`, `priceInDollars`,
`currency` and `rewardPoints`.

- `artistName` → `artist { id, name, slug }`.
- `priceInDollars` + `currency` → `price { amount, currency, isFree }`.
  `amount` is now always 2 decimals (`"110.00"`, not `"110"`).
- New fields: `description`, `rarity`, `category`, `totalSupply`,
  `mintedCount` and `isWishlisted`.
- New: `?category=` on `GET /marketplace`, `?featured=` on `/listings`,
  the never-empty `featured`, and optional auth for the heart.
