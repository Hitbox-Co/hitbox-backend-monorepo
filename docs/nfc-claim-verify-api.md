# NFC Claim API (demo)

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
3. Ledger: a **MINT** row (seq 0, origin = HitBox) if this is the SKU's first
   ledger activity, then the **CLAIM** row (seq 1).
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

The **MINT** row is now written lazily inside the claim transaction, so a chain
is never missing its origin. The one visible consequence: `GET /ledger/:tagId`
returns an empty array for a never-claimed item, where it used to return a
single MINT row. `ClaimsService.ensureOriginForSku(skuId)` is the hook for the
skus module to call when it binds a tag, once that module grows a service.

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
