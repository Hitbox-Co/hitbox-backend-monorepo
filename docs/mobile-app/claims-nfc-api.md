# Claims & NFC — API

The **Scan** tab. The user holds the phone against a collectible's NFC tag. The
app either checks that the item is genuine (verify) or makes the user its owner
(claim). A claimed item lands on the My Collection shelf
([collections-api.md](collections-api.md)).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/claim` | required | **Claim** an item with the tap URL's `u`, `e`, `c` |
| `GET` | `/verify?u=&e=&c=` | public | **Verify** an item from a tap URL. Never claims. |
| `GET` | `/ledger/:tagId` | public | Provenance chain (mint, claims, flags) for one item |
| `POST` | `/claims/:tagId` | required | *Deprecated.* Old validate step (tag id in path) |
| `POST` | `/claims/:tagId/confirm` | required | *Deprecated.* Old confirm step |
| `GET` | `/verify/:tagId` | public | *Deprecated.* Old verify by tag id |

New app code uses only `POST /claim`, `GET /verify` and `GET /ledger`. Code:
`packages/claims` (routes, DTOs, service) and `packages/skus` (the tap verifier).

---

## Authentication

`POST /claim` and the two deprecated `/claims` routes need the Clerk session JWT:

```http
Authorization: Bearer <clerk-session-token>
```

The claimer is **always the signed-in user**. There is no "claim for someone
else" field. `GET /verify` and `GET /ledger` are public and ignore the token.
Auth error codes (401/403) are listed in [auth-api.md](auth-api.md).

---

## End-to-end flow

### What is on the tag

Every collectible has an NTAG 424 DNA chip with its own secret keys. The keys
live only on the chip and (wrapped) on the server. The chip stores an NDEF URL.
On each tap the chip fills in fresh `e` and `c` values:

```
https://hitboxcollectibles.com/verify?u=04A1B2C3D4E5F6&e=5D3A…(32 hex)&c=9F1E…(16 hex)
```

| Param | Format | What it is |
|---|---|---|
| `u` | 14 hex chars | Chip UID (plain text). A lookup hint only. |
| `e` | 32 hex chars | Encrypted chip data: UID + tap counter |
| `c` | 16 hex chars | Signature (MAC) over the tap |

**The app never decrypts anything and holds no keys.** It reads the URL from
the tag, takes `u`, `e` and `c` out of the query string, and sends them to the
server as-is (upper or lower case is fine).

### One tap = one request

The chip's counter goes up on every tap. The server accepts each counter value
**once**. So the values from one tap can be sent to **either** `GET /verify`
**or** `POST /claim`, never both. The second request is treated as a replay and
answers `NOT_VERIFIED`.

To claim after a verify, ask the user to **tap again**.

### Step by step

```
 user taps tag
      │
      ▼
 app reads NDEF URL → u, e, c
      │
      ├── "Check authenticity" screen ──▶ GET /verify?u=&e=&c=     (no login)
      │                                     → verified / claimed / owner
      │
      └── "Claim" screen (signed in) ───▶ POST /claim { u, e, c, visibility }
                                            → outcome: CLAIMED | ALREADY_CLAIMED | …
                                            → item is on GET /collections/me
```

1. **Read the tag.** Get the URL, parse `u`, `e`, `c`.
2. **Pick one call** for this tap:
   - Signed out, or the user only wants to check: `GET /verify`.
   - Signed in and on the claim screen: `POST /claim` directly. It verifies
     the tap itself, so there is no separate verify step before it.
3. **Server checks the tap** (same for both calls): known chip, chip active,
   keys present, decrypts `e`, UID inside `e` equals `u`, signature `c` is
   right, chip is in an item, counter is higher than last time. Any failure →
   `verified: false` with one generic message. The reason is logged on the
   server and never returned.
4. **Verify** reports the item and its state. Nothing changes.
5. **Claim** then:
   - Item `UNCLAIMED` → the caller becomes the owner, in one transaction (see
     [What a claim writes](#what-a-claim-writes)). `outcome: "CLAIMED"`.
   - Item already `CLAIMED` → nothing changes. `outcome: "ALREADY_CLAIMED"`,
     with `claimedByYou` true if it is yours.
   - Someone else claimed it while this request was running →
     `outcome: "CLAIMED_BY_OTHER_JUST_NOW"`.
   - Item `FLAGGED` (fraud hold / refund quarantine) or `IN_TRANSFER` →
     `outcome: "UNAVAILABLE"`.
6. **Show the result** from the response. On `CLAIMED`, refresh
   `GET /collections/me` and `GET /collections/me/stats`. A claim can also
   unlock a collection reward ([rewards-api.md](rewards-api.md)).

**No claim token in the tap flow.** The signed tap itself proves the user is
holding the item. Claim tokens belong only to the deprecated `/claims` flow.

---

## Shapes

### `Owner`

```jsonc
{
  "id": "2b7c9d10-…",       // account id → GET /collections/user/:id for their showcase
  "handle": "jameela",      // null if not set
  "displayName": "jameela"  // handle, else full name; null if neither
}
```

### `TapProduct`: the drop behind the item

```jsonc
{
  "id": "6f1c9e44-…",                   // drop id → GET /products/:id
  "groupCode": "HB-KAZE-001",           // public drop code
  "name": "Kaze Genesis — Single Card",
  "status": "ACTIVE",                   // DropStatus: DRAFT … ACTIVE, ENDED, ARCHIVED
  "rarity": "RARE",                     // free-form; null if not set
  "imageUrl": "https://cdn.example.com/drops/kaze-genesis.webp", // null if none
  "priceInDollars": "49.00",            // base price, default market; null if none
  "currency": "USD"                     // null when priceInDollars is null
}
```

### `NotVerified`

Any tap that fails a check. Always HTTP **200**.

```jsonc
{ "verified": false, "message": "We could not verify this item. Try tapping again." }
// POST /claim adds:  "outcome": "NOT_VERIFIED"
```

### `LedgerEntry`

```jsonc
{
  "sequenceNo": 1,              // 0 = origin (MINT)
  "txType": "CLAIM",            // MINT | CLAIM | TRANSFER | FLAG | UNFLAG | REVOKE | REISSUE
  "productId": "HB-KAZE-001",   // the drop's groupCode (not the uuid)
  "tag": "534A70C1610001",      // legacy Sku.tagId; null for chips registered by consignment
  "ownerId": "jameela",         // "HitBox" on the origin row, else the owner's handle/name;
                                // null when that owner keeps the item PRIVATE or no longer owns it
  "dateTime": "2026-11-03T11:02:00.000Z",
  "hash": "9b2f…(64 hex)",      // SHA-256 of this record
  "previousHash": "41c0…",      // hash of the row before; null for the origin
  "claimHistory": true,         // is this row a claim?
  "peerToPeerTrading": true     // same value as claimHistory
}
```

---

## Endpoints

### `POST /api/v1/claim`

Claim the tapped item for the signed-in user.

Request body (unknown fields → 422, including the old `b`):

| Field | Type | Rules |
|---|---|---|
| `u` | string | required, exactly 14 hex chars |
| `e` | string | required, exactly 32 hex chars |
| `c` | string | required, exactly 16 hex chars |
| `visibility` | string | optional, `PUBLIC` or `PRIVATE`, default `PRIVATE`. Visibility of the new shelf row. Ignored when nothing is claimed. |

```json
{
  "u": "04A1B2C3D4E5F6",
  "e": "5D3A0C9F1E2B4A6C8D7E9F0A1B2C3D4E",
  "c": "9F1E2D3C4B5A6978",
  "visibility": "PRIVATE"
}
```

Response, `CLAIMED`:

```json
{
  "data": {
    "verified": true,
    "outcome": "CLAIMED",
    "claimedByYou": true,
    "message": "You claimed \"Kaze Genesis — Single Card\". You now own it.",
    "owner": { "id": "2b7c9d10-…", "handle": "jameela", "displayName": "jameela" },
    "sku": { "id": "c41d7f20-…", "skuCode": "HB-KAZE-001-000014", "serialNumber": 14, "claimedStatus": "CLAIMED" },
    "product": {
      "id": "6f1c9e44-…", "groupCode": "HB-KAZE-001", "name": "Kaze Genesis — Single Card",
      "status": "ACTIVE", "rarity": "RARE", "imageUrl": "https://cdn.example.com/drops/kaze-genesis.webp",
      "priceInDollars": "49.00", "currency": "USD"
    },
    "claimedAt": "2026-11-03T11:02:00.000Z",
    "claim": { "id": "a7e3…", "claimCode": "HBPC482913", "claimedNo": 1 }
  }
}
```

Response, someone else owns it and keeps it private:

```json
{
  "data": {
    "verified": true,
    "outcome": "ALREADY_CLAIMED",
    "claimedByYou": false,
    "message": "\"Kaze Genesis — Single Card\" is already claimed by another collector.",
    "owner": null,
    "sku": { "id": "c41d7f20-…", "skuCode": "HB-KAZE-001-000014", "serialNumber": 14, "claimedStatus": "CLAIMED" },
    "product": { "…": "TapProduct" },
    "claimedAt": "2026-10-21T08:15:00.000Z",
    "claim": null
  }
}
```

All `outcome` values, all HTTP 200:

| `outcome` | `claimedByYou` | `owner` | `claim` | Show |
|---|---|---|---|---|
| `CLAIMED` | `true` | you | the new claim record | "You own it" |
| `ALREADY_CLAIMED` | `true` | you | `null` | "You already own this" |
| `ALREADY_CLAIMED` | `false` | owner, or `null` if private | `null` | "Already claimed by …" |
| `CLAIMED_BY_OTHER_JUST_NOW` | `false` | winner, or `null` if private | `null` | "Someone just beat you to it" |
| `UNAVAILABLE` | `false` | `null` | `null` | "Can't be claimed right now" |
| `NOT_VERIFIED` | — | — | — | "Couldn't verify, tap again" (`NotVerified` shape) |

`claim.claimCode` is `HBPC` + 6 digits. `claim.claimedNo` counts claims on this
unit (1 for the first, 2 after a revoke and re-claim).

Branch on `verified` and `outcome`, never on the HTTP status.

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_*` | Not signed in, see [auth-api.md](auth-api.md) |
| 422 | `VALIDATION_ERROR` | `u`/`e`/`c` missing or wrong length/characters, bad `visibility`, extra field |
| 400 | `BODY_REQUIRED` | No JSON body parsed (missing `Content-Type: application/json`) |
| 409 | `CLAIMS_CODE_TAKEN` | Could not generate a unique claim code (rare; retry with a new tap) |
| 429 | `RATE_LIMITED` | Over the tap limits (below) |
| 503 | `CLAIMS_TAP_UNAVAILABLE` | Tap verification is not configured on this server |
| 500 | `INTERNAL_ERROR` | Server could not unwrap the chip's keys |

### `GET /api/v1/verify?u=&e=&c=`

Check that an item is genuine and see its state. **Never claims**, but it does
use up the tap (see [One tap = one request](#one-tap--one-request)). The
response has `Cache-Control: no-store`.

| Param | Type | Rules |
|---|---|---|
| `u` | string | required, 14 hex chars |
| `e` | string | required, 32 hex chars |
| `c` | string | required, 16 hex chars |

```json
{
  "data": {
    "verified": true,
    "claimed": true,
    "claimedStatus": "CLAIMED",
    "sku": { "id": "c41d7f20-…", "skuCode": "HB-KAZE-001-000014", "serialNumber": 14 },
    "product": { "…": "TapProduct" },
    "owner": { "id": "2b7c9d10-…", "handle": "jameela", "displayName": "jameela" },
    "claimedAt": "2026-11-03T11:02:00.000Z",
    "verifiedAt": "2026-11-18T09:30:12.000Z"
  }
}
```

- `claimed` is `true` only when `claimedStatus` is `CLAIMED`.
- `owner` is `null` when unclaimed, **or** when the owner keeps the item
  `PRIVATE`. This endpoint is anonymous, so even the owner's own scan shows
  `null` for a private item.
- A failed tap returns the `NotVerified` shape with HTTP 200.

| Status | Code | When |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Missing or malformed `u`/`e`/`c` |
| 429 | `RATE_LIMITED` | Over the tap limit |
| 503 | `CLAIMS_TAP_UNAVAILABLE` | Tap verification not configured |

### `GET /api/v1/ledger/:tagId`

The item's provenance chain, oldest first. Public. Does not use up a tap, so it
can be called any time (for example from an item detail screen).

| Param | Type | Rules |
|---|---|---|
| `tagId` | path string | 1–64 chars. Either the legacy `Sku.tagId`, or the chip UID (`u` from the tap URL; `:`, `-` and spaces are stripped, case ignored) |

```jsonc
{
  "data": [
    { "sequenceNo": 0, "txType": "MINT",  "ownerId": "HitBox",  "previousHash": null, "claimHistory": false, "…": "…" },
    { "sequenceNo": 1, "txType": "CLAIM", "ownerId": "jameela", "previousHash": "<hash of row 0>", "claimHistory": true, "…": "…" }
  ]
}
```

Each row's `previousHash` equals the `hash` of the row before it. The app can
show this as a chain; it does not need to recompute hashes.

| Status | Code | When |
|---|---|---|
| 404 | `CLAIMS_TAG_NOT_FOUND` | No item has this tag id / UID |
| 422 | `VALIDATION_ERROR` | `tagId` empty or over 64 chars |

---

## How it works

### What a claim writes

All in one database transaction, so either everything happens or nothing does:

1. The unit (`Sku`) goes from `UNCLAIMED` to `CLAIMED` with the caller as
   owner. This is a compare-and-swap: only one of two simultaneous taps can win.
2. A claim record (`claimCode`, `claimedNo`) is created.
3. The ledger gets a `CLAIM` row (and the `MINT` origin row if the unit had none).
4. An ownership-history period opens.
5. The chip and the unit move to `ACTIVE`.
6. A shelf row is created in My Collection with the requested `visibility`.

After the commit, a `claims.product.claimed` event fires. The rewards module
uses it to unlock collection rewards ([rewards-api.md](rewards-api.md)).

### Item states (`claimedStatus`)

| State | Claimable? | Meaning |
|---|---|---|
| `UNCLAIMED` | yes | No owner yet, or a claim was revoked |
| `CLAIMED` | no | Has an owner |
| `FLAGGED` | no (`UNAVAILABLE`) | Frozen: fraud hold or refund quarantine |
| `IN_TRANSFER` | no (`UNAVAILABLE`) | Being transferred |

A claim can be **revoked** by the server when the order is refunded or a
dispute is lost. The unit goes back to `UNCLAIMED` (or `FLAGGED` for a
quarantine window), the owner is cleared, the shelf row is archived, and the
ledger gains a row. Nothing is deleted. There is no user-facing revoke API.

### Owner privacy

Someone else's owner details are shown **only when that owner made the item
`PUBLIC`** in their collection. This applies everywhere an owner can appear: `GET /verify`,
`POST /claim`, `GET /ledger/:tagId` (`ownerId` is `null`), and the deprecated
`GET /verify/:tagId`, `POST /claims/:tagId` and `/confirm` (the owner comes back
empty: `{ "id": "", "handle": null, "displayName": null }`). Otherwise `owner` is `null` and the message says
"another collector". On `POST /claim` you always see yourself when you are the
owner (`claimedByYou: true`). To change it, the owner uses
`PATCH /collections/me/:skuId` ([collections-api.md](collections-api.md)).

### Simultaneous taps

Two users claiming the same unit at the same moment: one gets `CLAIMED`, the
other `CLAIMED_BY_OTHER_JUST_NOW`. If you double-tap your own item, the second
request returns `ALREADY_CLAIMED` with `claimedByYou: true`, not a lost race.

### Rate limits

On top of the global limit (100 requests / 60 s per IP):

| Limit | Applies to |
|---|---|
| 30 / 60 s per IP | `GET /verify` and `POST /claim` **together** (one shared counter) |
| 15 / 60 s per signed-in user | `POST /claim` |

Over the limit → `429 RATE_LIMITED`. `GET /ledger` has only the global limit.

---

## Deprecated tag-id flow

Kept for old clients. These routes send a `Deprecation: true` header and turn
into `410 CLAIMS_LEGACY_ROUTE_DISABLED` when the server sets
`CLAIMS_LEGACY_TAG_ROUTES=false`. `:tagId` is the raw tag id or chip UID; it
proves nothing about holding the item, which is why it was replaced.

1. `POST /claims/:tagId` (auth) — **validate**. Changes nothing. Returns
   `screen` (`CLAIMABLE` | `ALREADY_CLAIMED_BY_YOU` | `ALREADY_CLAIMED`),
   `claimedByYou`, `sku`, `product` (`id`, `groupCode`, `name`,
   `priceInDollars`, `currency`, `status`, `imageUrl`), `owner`, `claimedAt`,
   and on `CLAIMABLE` only a one-shot `claimToken` with `claimTokenExpiresAt`
   (**120 seconds**). A new validate replaces the previous token for the same
   user and item.
2. `POST /claims/:tagId/confirm` (auth) — **claim**. Body
   `{ "claimToken": "<from validate>", "visibility": "PRIVATE" }` (`claimToken`
   16–256 chars; `visibility` default `PRIVATE`; unknown fields → 422). Returns
   `outcome` (`CLAIMED` | `ALREADY_CLAIMED` | `CLAIMED_BY_OTHER_JUST_NOW`),
   `claimedByYou`, `message`, `owner`, `sku` (with `tagId`, `claimedStatus`),
   `product` (`id`, `groupCode`, `name`), `claimedAt`, `claim`.
3. `GET /verify/:tagId` (public) — returns `valid`, `skuId`, `skuCode`,
   `serialNumber`, `productId`, `groupCode`, `name`, `claimed`,
   `claimedStatus`, `status`, `owner`, `ledgerLength`, `verifiedAt`.

Token errors on confirm:

| Status | Code | When |
|---|---|---|
| 400 | `CLAIMS_TOKEN_INVALID` | Token missing (when the server requires it), unknown, or issued to another user/item |
| 409 | `CLAIMS_TOKEN_REUSED` | Token already used, replaced by a newer validate, or lost a race |
| 410 | `CLAIMS_TOKEN_EXPIRED` | Older than 120 s |
| 404 | `CLAIMS_TAG_NOT_FOUND` | No item has this tag (also on validate and verify) |

On 409/410 the app validates again. Whether a missing token is accepted depends
on the server flag `CLAIM_TOKEN_REQUIRED` (off by default).

---

## Known limitations

- **Verify then claim needs two taps.** By design: one tap's values are good
  for one request.
- **Hidden ledger rows cannot be re-hashed.** Each `hash` was computed over the
  real owner label. When `ownerId` is `null` for privacy, a client cannot
  recompute that row's hash, though the `previousHash` links still chain.
- **Past owners are always hidden in the ledger.** Once an item moves on, the
  previous owner's shelf row is archived, so their rows read `null`.
- **Deprecated confirm on a frozen item.** The old confirm has no
  `UNAVAILABLE` outcome. A `FLAGGED` or `IN_TRANSFER` unit can come back as
  `CLAIMED_BY_OTHER_JUST_NOW`.
- **`peerToPeerTrading` is a placeholder.** It always equals `claimHistory`;
  there is no P2P trading API.
- **Re-claim keeps old shelf settings.** If a revoked unit is claimed again by
  the same user, the old shelf row is restored with its old `visibility`; the
  `visibility` in the request is not applied.
