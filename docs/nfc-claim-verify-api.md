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
matches no SKU), `422 VALIDATION_ERROR` (bad body).

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
| `CLAIMS_TAG_NOT_FOUND` | 404 | No SKU is registered to the tag |
| `CLAIMS_CODE_TAKEN`    | 409 | Couldn't allocate a unique claim code (retries exhausted) |
| `UNAUTHENTICATED`      | 401 | Missing/invalid session on `POST /claim` |
| `VALIDATION_ERROR`     | 422 | Path param or body failed schema validation |

Note: "already claimed" is **not** an error — it's a normal `200` with
`outcome: "ALREADY_CLAIMED"`.

---

## Quick curl walkthrough

```bash
# Tap 1 — claim it (authenticated)
curl -X POST http://localhost:4000/api/v1/claim/E2ETAG0000001 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"visibility":"PUBLIC"}'
# → outcome: "CLAIMED", you are the owner

# Tap 2 — someone else taps the same tag
curl -X POST http://localhost:4000/api/v1/claim/E2ETAG0000001 \
  -H "Authorization: Bearer $OTHER_TOKEN"
# → outcome: "ALREADY_CLAIMED", message: "… already claimed by <name>."

# Read-only status / provenance (no auth)
curl http://localhost:4000/api/v1/verify/E2ETAG0000001
curl http://localhost:4000/api/v1/ledger/E2ETAG0000001
```

An automated end-to-end run of this exact flow lives in
[nfc-api-e2e-test-report.md](nfc-api-e2e-test-report.md).
```
