# NFC Claim API (demo)

> **Current flow:** see [Secure tap flow](#secure-tap-flow-current-tap-url--verify--claim) — `POST /claim` and `GET /verify?b=&e=&c=`. The tag-id routes below are deprecated.

The authenticity flow behind HitBox collectibles. Every physical item ships
with an NFC tag (`Sku.tagId`). A user taps the tag to **claim** first
ownership. Re-tapping a claimed item just tells you **who owns it**.

> **A tag identifies a SKU, not a product.** The tag moved from `Product.tagId`
> to `Sku.tagId` in the catalog restructure, and claim state, ownership and the
> provenance chain all moved with it. This is the correct shape: a tag is glued
> to one serialized item, so copies #7 and #8 of the same drop now have their
> own claim records and their own ledgers instead of sharing one. Every
> response below therefore carries **both** the `sku` (the thing you hold) and
> the `product` (the catalog entry behind it).

- **Base URL:** `/api/v1`
  - Local: `http://localhost:8000/api/v1`
  - Public (what the app + Clerk webhooks use): `https://ultra-coveting-payroll.ngrok-free.dev/api/v1` — ngrok tunnels to local `:8000`.
  - **ngrok-free clients must send** `ngrok-skip-browser-warning: true`, or the first request returns the ngrok HTML interstitial instead of JSON.
- **Owning module:** [`packages/claims`](../packages/claims) (owns
  `ProductClaim`, `BlockchainLedger` and `ProductHistory` — all keyed by
  `skuId`).
- **Auth:** Clerk bearer token or `__session` cookie → the auth middleware sets
  `req.auth`. The claimer is always `req.auth.accountId`, never the request body.

> **Scope note:** peer-to-peer **transfer/trading is intentionally out of scope**
> for the demo. The ledger still supports it (a `TRANSFER` row type exists) but
> no transfer endpoint is exposed.

---

## Secure tap flow (current): tap URL → verify → claim

> **This is the flow the app uses.** The tag-id routes further down
> (`POST /claims/:tagId`, `POST /claims/:tagId/confirm`, `GET /verify/:tagId`) are
> **deprecated**. They keep working, and answer with a `Deprecation: true` header,
> until `CLAIMS_LEGACY_TAG_ROUTES=false` turns them into `410`.

Every collectible carries an NXP NTAG 424 DNA chip. On each tap the chip writes
a fresh URL:

```
https://hitboxcollectibles.com/verify?b=<batch code>&e=<32 hex>&c=<16 hex>
```

| Param | What it is |
|---|---|
| `b` | Which batch's keys to use: the key set's short code (e.g. `101`, 3–20 chars of `A-Z a-z 0-9 . _ -`) **or** its long `publicCode` (`nks…`, 22 chars). A lookup label only — public, not a secret; the keys, not `b`, are what authenticate a tap. Shorter is better for tag memory. |
| `e` | Encrypted PICC data (AES-128-CBC, zero IV, **Key 01**): `0xC7 \| UID(7) \| counter(3, LE) \| padding`. |
| `c` | SDM MAC (**Key 02**): 8 bytes of an AES-CMAC under a session key derived from Key 02, the UID and the counter. |

The counter goes up on every tap, so **a URL is good for exactly one use.**

**The app never decrypts and never holds a key.** It reads the URL from the tag
and sends `b`, `e`, `c` to the server. Keys exist only wrapped (encrypted by a
KMS) in `NfcKeySet`.

### Per-tag keys: `u` instead of `b` (preferred)

Each chip can instead carry **its own** Key 00/01/02 (table `NfcTagKey`, wrapped by the KMS),
and its UID written into the URL as plain text:

```
https://hitboxcollectibles.com/verify?u=<UID, 14 hex>&e=<32 hex>&c=<16 hex>
```

Send **exactly one** of `u` or `b` (both, or neither, is a 400). `u` is only a lookup hint: anyone can
edit it, so the UID that the chip encrypted into `e` must equal it. Both `POST /claim` and
`GET /verify` take `u`/`e`/`c`; the response shapes are unchanged. Per-tag `e`/`c` are single-use
exactly like the batch form: call **either** claim **or** verify for one tap, never both (the second is a `REPLAY`).

Server order for `u` (reason codes are logged in `NfcVerification.reasonCode`, never returned):

| # | Step | Refused as |
|---|---|---|
| 1 | format: `u` 14 hex, `e` 32 hex, `c` 16 hex | `BAD_FORMAT` |
| 2 | find the chip by `ITagCipher.hash(u.toUpperCase())` | `UNKNOWN_TAG` |
| 3 | chip lifecycle `BOUND` or `ACTIVE` | `TAG_NOT_ACTIVE` |
| 4 | the chip's ACTIVE `NfcTagKey` row | `NO_KEYS` (never keyed, revoked, or the row names another UID) |
| 5 | unwrap Key 01 / Key 02 (memory only, zeroed after) | *(HTTP 500, not logged as tamper)* |
| 6 | decrypt `e` with Key 01, first byte `0xC7` | `BAD_PICC` |
| 7 | UID inside `e` equals `u` (constant time) | `UID_MISMATCH` |
| 8 | check `c` with Key 02 (constant time) | `BAD_CMAC` |
| 9 | chip is embedded in a unit | `NO_ITEM` |
| 10 | atomic `updateMany where lastTapCounter < counter` on the **`NfcTagKey`** row | `REPLAY` |

The counter lives on `NfcTagKey.lastTapCounter` (new rows start at `-1`, so a first tap with counter 0
passes); `NfcTag.lastTapCounter` is never touched by a per-tag tap. The `NfcVerification` row records
`nfcTagKeyId` (and `keySetId` for a batch tap).

Key management (admin, permission `nfc-tag-claim:manage:global`; responses with keys are `no-store`):

| Route | Does |
|---|---|
| `POST /admin/supply/tags/:tagId/keys` | generate Key 00/01/02 for one chip; returns the keys, UID and URL **once** |
| `POST /admin/supply/batches/:batchId/tag-keys` | body `{ limit? }` (default 500, max 1000); keys that many un-keyed chips, returns a CSV once (contains secrets, delete after programming) and how many remain |
| `POST /admin/supply/tag-keys/:nfcTagKeyId/personalize` | record that the keys were written onto the chip |
| `POST /admin/supply/tags/:tagId/keys/revoke` | body `{ reason }`; the chip then fails `NO_KEYS` until re-keyed (old rows are kept) |
| `GET /admin/supply/tags/:tagId/keys` | the active key row's metadata, never key material |

Audit events: `supply.tag-keys.generate`, `supply.tag-keys.personalize`, `supply.tag-keys.revoke`.

### Batch keys: `b` (existing form)

### What the server does, in this order

| # | Step | Refused as (logged only — never sent to the caller) |
|---|---|---|
| 1 | find `NfcKeySet` by `b` (`publicCode` if it looks like `nks…`, otherwise `keySetCode`) | `UNKNOWN_BATCH` |
| 2 | key set must be `ACTIVE` | `KEY_SET_RETIRED` |
| 3 | unwrap Key 01 / Key 02 | *(HTTP 500, not logged as tamper)* |
| 4 | decrypt `e` with Key 01 → UID + counter | `BAD_PICC` |
| 5 | find the chip by UID hash (`ITagCipher.hash`) | `UNKNOWN_TAG` |
| 6 | chip's `keySetId` must equal the batch | `BATCH_MISMATCH` |
| 7 | chip lifecycle `BOUND` or `ACTIVE` | `TAG_NOT_ACTIVE` |
| 8 | check `c` with Key 02 (constant time) | `BAD_CMAC` |
| 9 | chip must be embedded in a unit (`Sku.currentNfcTagId`) | `NO_ITEM` |
| 10 | atomic `updateMany where lastTapCounter < counter` must change 1 row | `REPLAY` |

The counter is consumed only at step 10, after everything else passed, so a
forged URL can never burn a real chip's counter. Every attempt writes one
`NfcVerification` row (result, `reasonCode`, counter, chip, unit, `keySetId`,
request id) — never `e`, `c`, the UID or a key.

### `POST /claim` 🔒

```json
{ "b": "nks…", "e": "<32 hex>", "c": "<16 hex>", "visibility": "PRIVATE" }
```

`visibility` is optional (`PUBLIC` | `PRIVATE`, default `PRIVATE`). The claimer is
always the signed-in user. Unknown body fields are a `422`.

- Tap does not authenticate → **HTTP 200**
  `{ "data": { "verified": false, "outcome": "NOT_VERIFIED", "message": "…" } }`.
  The message is the same whatever failed (forged, replayed, retired, unknown).
- Authenticated and unclaimed → claims it (the existing transaction: `Sku` →
  `CLAIMED`, `SkuClaim`, MINT/CLAIM ledger rows, `SkuHistory`,
  `BuyerCollection`, `claims.product.claimed`) and moves the chip and unit to
  `ACTIVE`. `outcome: "CLAIMED"`.
- Authenticated and already claimed → **changes nothing**. `outcome:
  "ALREADY_CLAIMED"`, with `claimedByYou`.

`outcome` is one of `CLAIMED`, `ALREADY_CLAIMED`,
`CLAIMED_BY_OTHER_JUST_NOW` (lost a simultaneous race by milliseconds),
`UNAVAILABLE` (authentic, but frozen or in transfer), or `NOT_VERIFIED`.

```json
{
  "data": {
    "verified": true,
    "outcome": "CLAIMED",
    "claimedByYou": true,
    "message": "You claimed \"Demo Collectible\". You now own it.",
    "owner": { "id": "…", "handle": "alice", "displayName": "alice" },
    "sku": { "id": "…", "skuCode": "HB-DEMO-001-000007", "serialNumber": 7, "claimedStatus": "CLAIMED" },
    "product": {
      "id": "…", "groupCode": "HB-DEMO-001", "name": "Demo Collectible", "status": "ACTIVE",
      "rarity": "RARE", "imageUrl": "https://…", "priceInDollars": "49.00", "currency": "USD"
    },
    "claimedAt": "2026-10-26T10:00:00.000Z",
    "claim": { "id": "…", "claimCode": "HBPC123456", "claimedNo": 1 }
  }
}
```

### `GET /verify?u=&e=&c=` (or `?b=&e=&c=`) (public, no login)

Authenticity check only. **Never claims.** Returns `{ verified, claimed,
claimedStatus, sku, product, owner, claimedAt, verifiedAt }`, or the generic
`{ verified: false, message }`.

> **One tap = one use.** A URL spent on `GET /verify` is rejected as a replay if
> it is then sent to `POST /claim`. The app calls **either** verify **or** claim
> with a given tap, never both. In the Claim section it calls claim directly; to
> claim after a verify the user taps again.

### Owner privacy (both endpoints)

Someone else's owner details (`owner`) are returned **only when that owner made
the item `PUBLIC`**. If it is `PRIVATE` (or the owner has no live collection
entry) `owner` is `null` and the message says "claimed by another collector".
The owner always sees themselves (`claimedByYou: true`).

### Rate limits

On top of the global limiter: `GET /verify` 30 / min per IP; `POST /claim` 30 /
min per IP **and** 15 / min per user. Over the limit → `429`.

### Status codes

| Code | Meaning |
|---|---|
| 200 | Any authenticated or unauthenticated tap (check `verified` / `outcome`) |
| 401 | `POST /claim` without a session |
| 422 | Malformed `b` / `e` / `c`, or an unknown body field |
| 429 | Rate limited |
| 503 | No verifier configured (no key wrapper or `NFC_TAG_UID_KEY`) |
| 500 | Batch keys could not be unwrapped (server fault) |

### Setting up a batch (admin, `nfc-tag-claim:manage:global`)

| Route | Purpose |
|---|---|
| `POST /admin/supply/key-sets` | Create Key 00/01/02 for a batch. Returns the plaintext keys **once**, for programming the chips. |
| `GET /admin/supply/key-sets` | List key sets. Never returns key material. |
| `POST /admin/supply/key-sets/:id/personalise` | Give a consignment's un-keyed chips this key set. |
| `POST /admin/supply/key-sets/:id/retire` | Retire a set: every chip in it fails verification. One-way. |

When a consignment is accepted and minted into units, each chip moves to
`BOUND` — which is what lets a tap verify.

### Environment

| Variable | Purpose |
|---|---|
| `NFC_TAG_UID_KEY` | ≥32 chars. Hashes chip UIDs (`NfcTag.tagUidHash`). Do not change once chips are registered. |
| `NFC_KMS_KEY_REF` | Names the KMS key that wraps batch keys. |
| `NFC_LOCAL_WRAP_KEY` | **Development only.** ≥32 chars. Local stand-in for a KMS; refused when `NODE_ENV=production`. |
| `CLAIMS_LEGACY_TAG_ROUTES` | `false` turns the deprecated tag-id routes into `410`. |

---

## Legacy tag-id flow (deprecated)

The sections below describe the original flow, keyed by the raw chip UID in the
path. It is kept for existing clients only.

---

## The one URL you need: `POST /claim/:tagId`

This single endpoint *is* the tap flow:

- **Unclaimed** → it claims the item for the caller, who becomes the owner.
  `outcome: "CLAIMED"`.
- **Already claimed** → it does **not** error. It returns the current owner so
  the app can show *"already claimed by &lt;name&gt;"*. `outcome: "ALREADY_CLAIMED"`.

Both cases return **HTTP 200**; branch on `outcome` (and `claimedByYou`), not on
the status code. Only a tag that matches no SKU returns `404`.

### Request

```http
POST /api/v1/claim/E2ETAG0000001
Authorization: Bearer <clerk_session_jwt>
Content-Type: application/json
```

```json
{ "visibility": "PUBLIC" }
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `visibility` | `"PUBLIC" \| "PRIVATE"` | `"PRIVATE"` | Visibility of the collection entry created on a successful claim. Ignored when already claimed. |

(The body is optional — `POST` with no body claims with `PRIVATE` visibility.)

### Response A — first tap, claimed (`200`)

```json
{
  "data": {
    "outcome": "CLAIMED",
    "claimedByYou": true,
    "message": "You claimed \"Aurora Genesis Card #001\". You now own it.",
    "owner": { "id": "clx9user0007", "handle": "jameela", "displayName": "jameela" },
    "sku": { "id": "clx9sku0001", "skuCode": "SKU-0001", "serialNumber": 1, "tagId": "E2ETAG0000001", "claimedStatus": "CLAIMED" },
    "product": { "id": "clx9prod0001", "groupCode": "482910370000", "name": "Aurora Genesis Card #001" },
    "claimedAt": "2026-07-23T12:00:00.000Z",
    "claim": { "id": "clx9claim01", "claimCode": "HBPC482910", "claimedNo": 1 }
  }
}
```

### Response B — re-tap by someone else, already claimed (`200`)

```json
{
  "data": {
    "outcome": "ALREADY_CLAIMED",
    "claimedByYou": false,
    "message": "\"Aurora Genesis Card #001\" is already claimed by jameela.",
    "owner": { "id": "clx9user0007", "handle": "jameela", "displayName": "jameela" },
    "sku": { "id": "clx9sku0001", "skuCode": "SKU-0001", "serialNumber": 1, "tagId": "E2ETAG0000001", "claimedStatus": "CLAIMED" },
    "product": { "id": "clx9prod0001", "groupCode": "482910370000", "name": "Aurora Genesis Card #001" },
    "claimedAt": "2026-07-23T12:00:00.000Z",
    "claim": null
  }
}
```

(When the **owner** re-taps their own item, `claimedByYou` is `true` and the
message reads *"You already own …"*.)

### What a successful claim writes (one transaction)

1. `Sku` → `claimedStatus = CLAIMED`, `ownerId = caller`, `claimTokenUsedAt = now`
   (guarded so two simultaneous taps can't double-claim).
2. `ProductClaim` with a generated unique `claimCode` (`HBPC` + 6 digits).
   `claimedNo` counts claims on **that SKU** — unique `[skuId, claimedNo]`.
3. Ledger: the **CLAIM** row (seq 1), chained onto the MINT row (seq 0) the
   unit was minted with. For a unit minted before MINT-at-mint existed, the
   MINT row is written first, in this same transaction.
4. `ProductHistory` — any open period is closed (`isCurrent = false`,
   `endedAt = now`), then a new one opens with `acquiredVia = CLAIM` and
   `isCurrent = true`. Exactly one row per SKU is ever current.
5. `BuyerCollection` entry created (the only way items enter a shelf), keyed
   `[userId, skuId]`.
6. `claims.product.claimed` event published, carrying `skuId` **and**
   `productId`.

**Errors:** `401 UNAUTHENTICATED` (no session), `404 CLAIMS_TAG_NOT_FOUND` (tag
matches no SKU), `422 VALIDATION_ERROR` (bad body), plus the claim-token
errors in the next section.

---

## Claim integrity: the one-shot token (US-P018)

The two-step flow is `POST /claims/:tagId` (validate) then
`POST /claims/:tagId/confirm` (claim). Validate now mints a **single-use claim
token**; confirm spends it.

### Why

Without it, a confirm request is replayable. Capture one, and it does nothing
while the item stays claimed — but `revokeClaim()` puts a refunded unit back to
`UNCLAIMED`, and at that moment the captured request works and the refunded
buyer owns the item again. The token closes that: it is burned inside the claim
transaction, before the item is touched, and it never returns to a usable
state.

It also gives the loser of a simultaneous tap something specific to say. Two
people tapping at once used to get the same `ALREADY_CLAIMED` as someone
tapping an item claimed weeks ago.

### Validate — two new response fields

```json
{
  "data": {
    "screen": "CLAIMABLE",
    "claimToken": "3Yk9r0Xh2tQ7bN4vL8pW1zA6sD5fG3jK0mC2xV9qR8E",
    "claimTokenExpiresAt": "2026-09-29T14:02:00.000Z"
  }
}
```

| Field | Notes |
|-------|-------|
| `claimToken` | Raw token, returned **once**. Only the SHA-256 is stored. `null` on the `ALREADY_CLAIMED` and `ALREADY_CLAIMED_BY_YOU` screens — there is nothing to authorise. |
| `claimTokenExpiresAt` | ISO 8601, 120 seconds out. After this, re-validate. |

Re-validating the same item as the same user **supersedes** the previous token.
Another user's live token for the same item is untouched — that is the whole
reason this is a table (`ClaimToken`) and not the old `Sku.claimToken` column,
which could only hold one.

### Confirm — one new body field

```json
{ "visibility": "PUBLIC", "claimToken": "3Yk9r0Xh2tQ7bN4vL8pW1zA6sD5fG3jK0mC2xV9qR8E" }
```

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `claimToken` | `string` | See the flag below | The value from validate. Body is still `.strict()` — unknown fields are a `422`. |

### New outcome — `CLAIMED_BY_OTHER_JUST_NOW` (`200`)

```json
{
  "data": {
    "outcome": "CLAIMED_BY_OTHER_JUST_NOW",
    "claimedByYou": false,
    "message": "This item was just claimed by someone else.",
    "owner": { "id": "clx9user0007", "handle": "jameela", "displayName": "jameela" },
    "claim": null
  }
}
```

Returned only when the item was `UNCLAIMED` at the start of the request and
`CLAIMED` by the time the transaction ran — a genuine simultaneous tap. An item
that was already someone else's before the caller tapped still returns
`ALREADY_CLAIMED`, unchanged.

The losing tap's token is burned to `LOST_TIEBREAK`. A lost tap still spends its
token: leaving a reusable one behind would reopen the replay hole the moment the
item was ever revoked.

### Token errors

| Situation | HTTP | Code |
|-----------|:----:|------|
| Already used — consumed, lost a tiebreak, or superseded | `409` | `CLAIMS_TOKEN_REUSED` |
| Past its 120-second TTL | `410` | `CLAIMS_TOKEN_EXPIRED` |
| Missing (flag on), malformed, wrong user, or wrong item | `400` | `CLAIMS_TOKEN_INVALID` |

All three mean the same thing to a client: **call validate again** and confirm
with the new token. The sub-reason (wrong user vs. wrong item vs. never issued)
is logged, never returned — telling a caller which would let them probe whether
a token exists and who holds it.

### Rollout flag — `CLAIM_TOKEN_REQUIRED`

Env var, `false` by default.

| Flag | Confirm with no `claimToken` | Confirm with a `claimToken` |
|------|------------------------------|------------------------------|
| `false` (default) | Old behaviour, plus a log line with `metric: claims.token.missing` | Checked in full |
| `true` | `400 CLAIMS_TOKEN_INVALID` | Checked in full |

There is no mode in which a token that *was* sent is ignored. `CLAIMED_BY_OTHER_JUST_NOW`
applies either way — the race fix is not gated on the rollout.

Turn it on once app builds that predate the token are out of circulation.

### What the token adds to the claim transaction

Ahead of everything in the list above, and inside the same transaction:

0. **Burn the token** — a conditional update matching `tokenHash` + `skuId` +
   `userId` + `status = ISSUED` + not consumed + not expired. Zero rows matched
   throws, which rolls the whole transaction back, so a replayed request
   changes nothing on its way to being refused. Ordering matters: if the SKU
   flip ran first, a replay would claim the item and only then be rejected.

…and at the end, `ClaimToken.claimId` is set to the new claim, so a `CONSUMED`
token without a claim never commits.

A `claimCode` collision still retries. The rollback un-consumes the token too,
so the retry re-enters the transaction with it back at `ISSUED`.

### Analytics

| Event | Payload | Why |
|-------|---------|-----|
| `claims.token.rejected` | `{ skuId, userId, reason, tokenId, at }` | A trickle is clients retrying; a spike on one item or one actor is someone replaying captured requests. Only visible in aggregate. |
| `claims.tiebreak.lost` | `{ skuId, loserUserId, winnerUserId, tokenId, at }` | The only way to know how often two people genuinely tap at once. |

Both also write a structured log line carrying a `metric` field, so a log query
does not have to match on message text.

The `ClaimToken` table is the audit record — status, `replayCount`,
`lastReplayAt`, `requestId`. The raw token is never logged.

---

## Supporting read endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/verify/:tagId` | public | Status + current owner without claiming |
| `GET` | `/ledger/:tagId` | public | Provenance chain (raw ledger rows) |

> `GET /products/tag/:tagId` and `/products/tag/:tagId/history` **were removed.**
> Tags are no longer a product concept, and `ProductHistory` moved into this
> module keyed by `skuId`. `/verify/:tagId` returns the item and catalog detail
> those routes used to serve; `/ledger/:tagId` covers provenance.

### `GET /verify/:tagId`

```json
{ "data": {
  "valid": true,
  "skuId": "clx9sku0001", "skuCode": "SKU-0001", "serialNumber": 1,
  "productId": "clx9prod0001", "groupCode": "482910370000",
  "name": "Aurora Genesis Card #001", "claimed": true, "claimedStatus": "CLAIMED",
  "status": "ACTIVE",
  "owner": { "id": "clx9user0007", "handle": "jameela", "displayName": "jameela" },
  "ledgerLength": 2, "verifiedAt": "2026-07-23T12:00:00.000Z"
} }
```

`owner` is `null` while unclaimed. `404 CLAIMS_TAG_NOT_FOUND` for an unknown tag.

`productCode` became `groupCode` and `state` became `status`, now carrying
`DropStatus` (the drop lifecycle) rather than the removed `ProductState`.
`serialNumber` is the item position in its edition — "#1 of 500".

### `GET /ledger/:tagId`

Columns match the ledger spec: **Product Id, Tag #, Owner Id, DateTime, Hash #,
Claim History, PeerToPeer Trading.**

```json
{ "data": [
  { "sequenceNo": 0, "txType": "MINT",  "productId": "A10000000000", "tag": "TAG111111111", "ownerId": "HitBox",  "dateTime": "2026-06-15T00:00:00.000Z", "hash": "1a7b…", "previousHash": null,   "claimHistory": false, "peerToPeerTrading": false },
  { "sequenceNo": 1, "txType": "CLAIM", "productId": "A10000000000", "tag": "TAG111111111", "ownerId": "jameela", "dateTime": "2026-07-23T12:00:00.000Z", "hash": "9f2c…", "previousHash": "1a7b…", "claimHistory": true,  "peerToPeerTrading": true }
] }
```

---

## Blockchain ledger model

One **SKU** ledger is an append-only set of records — each serialized item has
its own chain, unique on `[skuId, sequenceNo]`. A **"First Time" origin
record** marks the item origin; a **claim adds a new record** with the buyer as
owner:

| `sequenceNo` | `txType` | Product Id | Tag # | Owner Id | Claim History | PeerToPeer Trading |
|:---:|:---|:---|:---|:---|:---:|:---:|
| 0 | `MINT`  | `A100…` | `TAG…` | `HitBox` | No | No |
| 1 | `CLAIM` | `A100…` | `TAG…` | buyer (e.g. `jameela`) | Yes | Yes |

- **Hash #** = `SHA-256(Product ID + Tag Id + Owner Id + DateTime of Creation)`
  — exactly the demo formula, see
  [`domain/ledger-hash.ts`](../packages/claims/src/domain/ledger-hash.ts). The
  E2E test recomputes this and asserts equality.
- Each record also stores `previousHash` (the prior record's hash) to link the
  chain, so tampering with an earlier record is detectable.
- **Claim History** = is this record a claim (`No` for the origin, `Yes` once a
  buyer claims). **PeerToPeer Trading** = whether this owner is P2P-eligible
  (the P2P *feature* is out of scope for the demo).

### Where the per-transaction detail lives

`BlockchainLedger` has no user foreign keys and no amount columns. The owner
label, `claimId`, buyer id and transaction amount are written to the row
`payload` JSON column, which is what that column exists for: detail that varies
by `txType` and must not change the table shape. The API reads it back and
flattens it into the responses above, so clients never see `payload` directly.

### When the origin row is written

Previously a `products.product.created` subscriber wrote it. That no longer
works: a product carries no tag, and its SKUs do not exist when it is created,
so the handler could only ever no-op. It was removed rather than left as
scaffolding.

The **MINT** row is written **when the unit is minted**, inside the minting
transaction (see [admin/sku-api.md §1](admin/sku-api.md#1-the-two-things-being-created)).
So `GET /ledger/:tagId` on a never-claimed item returns its single MINT row.

Units minted before that change have no MINT row until their first claim,
which writes it lazily inside the claim transaction — so a chain is never
missing its origin either way. `ClaimsService.ensureOriginForSku(skuId)`
remains as an idempotent way to backfill one unit.

---

## Error code reference

| Code | HTTP | Raised when |
|------|:----:|-------------|
| `CLAIMS_TAG_NOT_FOUND`  | 404 | No SKU is registered to the tag |
| `CLAIMS_CODE_TAKEN`     | 409 | Couldn't allocate a unique claim code (retries exhausted) |
| `CLAIMS_TOKEN_REUSED`   | 409 | The claim token was already spent — consumed, lost a tiebreak, or superseded |
| `CLAIMS_TOKEN_EXPIRED`  | 410 | The claim token passed its 120-second TTL |
| `CLAIMS_TOKEN_INVALID`  | 400 | Missing (with `CLAIM_TOKEN_REQUIRED=true`), malformed, or issued to another user or item |
| `UNAUTHENTICATED`       | 401 | Missing/invalid session on `POST /claims` |
| `VALIDATION_ERROR`      | 422 | Path param or body failed schema validation |

Note: "already claimed" is **not** an error — it's a normal `200` with
`outcome: "ALREADY_CLAIMED"`. Neither is losing a simultaneous tap: that is a
`200` with `outcome: "CLAIMED_BY_OTHER_JUST_NOW"`.

The three token errors all mean the same thing to a client: **call validate
again** and confirm with the new token. Retrying the same request can only fail
the same way.

---

## Quick curl walkthrough

```bash
# Step 1 — validate. Returns the screen to show AND a one-shot claim token.
CLAIM_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/claims/E2ETAG0000001 \
  -H "Authorization: Bearer $TOKEN" | jq -r .data.claimToken)
# → screen: "CLAIMABLE", claimToken: "3Yk9…", claimTokenExpiresAt: 120s out

# Step 2 — confirm, spending the token.
curl -X POST http://localhost:4000/api/v1/claims/E2ETAG0000001/confirm \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"visibility\":\"PUBLIC\",\"claimToken\":\"$CLAIM_TOKEN\"}"
# → outcome: "CLAIMED", you are the owner

# Replay that exact confirm — the attack the token stops.
curl -X POST http://localhost:4000/api/v1/claims/E2ETAG0000001/confirm \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"visibility\":\"PUBLIC\",\"claimToken\":\"$CLAIM_TOKEN\"}"
# → 409 CLAIMS_TOKEN_REUSED, and no second claim row

# Someone else taps the same tag — validate issues no token, nothing to claim.
curl -X POST http://localhost:4000/api/v1/claims/E2ETAG0000001 \
  -H "Authorization: Bearer $OTHER_TOKEN"
# → screen: "ALREADY_CLAIMED", claimToken: null

# Read-only status / provenance (no auth)
curl http://localhost:4000/api/v1/verify/E2ETAG0000001
curl http://localhost:4000/api/v1/ledger/E2ETAG0000001
```

An automated end-to-end run of this exact flow lives in
[nfc-api-e2e-test-report.md](nfc-api-e2e-test-report.md).
```
