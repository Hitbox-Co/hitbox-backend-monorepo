# NFC Claim API — End-to-End Test Report

**Result: ✅ ALL PASSED** — 60/60 assertions passed across 16 API calls.

- Run at: 2026-07-23 10:43 UTC
- Environment: throwaway local PostgreSQL (isolated; the production Neon DB was never touched)
- Migration applied: `20260723120000_add_ledger_provenance_chain`
- Auth: Clerk `requireAuth` replaced by a stub injecting `req.auth` for a seeded user, so two different "tappers" (jameela, akash) could be simulated. All other code paths are the real modules.

> The stub means Clerk's own JWT verification isn't exercised here — every other layer (routing, Zod validation, services, Prisma `$transaction`s, the hash chain, error mapping) is.

---

## Health

### ✅ #1 Health check

`GET /api/v1/health` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ status ok

Response:

```json
{
  "status": "ok",
  "uptime": 1.8296267
}
```

## Setup

### ✅ #2 Create product with NFC tag

`POST /api/v1/products` — as **jameela** → **201** (expected 201)

Request body:

```json
{
  "name": "Aurora Genesis Card #001",
  "type": "INDIVIDUAL",
  "category": "TRADING_CARD",
  "genre": "MUSIC",
  "rarity": "RARE",
  "priceInDollars": 49.99,
  "inventoryUnit": 10,
  "tagId": "E2ETAG0000001",
  "images": [
    {
      "title": "cover",
      "url": "https://example.com/e2e.png"
    }
  ]
}
```

Checks:

- ✅ status 201
- ✅ has cuid id
- ✅ productCode 12 chars
- ✅ tagId echoed
- ✅ claimedStatus UNCLAIMED

Response:

```json
{
  "data": {
    "id": "cmrxdv8nu0002epsok6gvz8o6",
    "productCode": "218004030000",
    "name": "Aurora Genesis Card #001",
    "type": "INDIVIDUAL",
    "category": "TRADING_CARD",
    "genre": "MUSIC",
    "description": null,
    "rewardPoints": 0,
    "state": "ACTIVE",
    "marketplaceStatus": null,
    "rarity": "RARE",
    "priceInDollars": "49.99",
    "inventoryUnit": 10,
    "unitsSold": 0,
    "tagId": "E2ETAG0000001",
    "claimedStatus": "UNCLAIMED",
    "claimedAt": null,
    "releaseDate": null,
    "createdAt": "2026-07-23T10:43:29.563Z",
    "updatedAt": "2026-07-23T10:43:29.563Z",
    "ownerId": null,
    "collectionId": null,
    "images": [
      {
        "id": "cmrxdv8nv0003epso4ikmfrmi",
        "title": "cover",
        "description": null,
        "url": "https://example.com/e2e.png",
        "productId": "cmrxdv8nu0002epsok6gvz8o6"
      }
    ],
    "collection": null
  }
}
```

## Products

### ✅ #3 Get product by tag

`GET /api/v1/products/tag/E2ETAG0000001` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ id matches created

Response:

```json
{
  "data": {
    "id": "cmrxdv8nu0002epsok6gvz8o6",
    "productCode": "218004030000",
    "name": "Aurora Genesis Card #001",
    "type": "INDIVIDUAL",
    "category": "TRADING_CARD",
    "genre": "MUSIC",
    "description": null,
    "rewardPoints": 0,
    "state": "ACTIVE",
    "marketplaceStatus": null,
    "rarity": "RARE",
    "priceInDollars": "49.99",
    "inventoryUnit": 10,
    "unitsSold": 0,
    "tagId": "E2ETAG0000001",
    "claimedStatus": "UNCLAIMED",
    "claimedAt": null,
    "releaseDate": null,
    "createdAt": "2026-07-23T10:43:29.563Z",
    "updatedAt": "2026-07-23T10:43:29.563Z",
    "ownerId": null,
    "collectionId": null,
    "images": [
      {
        "id": "cmrxdv8nv0003epso4ikmfrmi",
        "title": "cover",
        "description": null,
        "url": "https://example.com/e2e.png",
        "productId": "cmrxdv8nu0002epsok6gvz8o6"
      }
    ],
    "collection": null
  }
}
```

## Verify

### ✅ #4 Verify before claim (unclaimed)

`GET /api/v1/verify/E2ETAG0000001` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ valid true
- ✅ claimed false
- ✅ owner null

Response:

```json
{
  "data": {
    "valid": true,
    "productId": "cmrxdv8nu0002epsok6gvz8o6",
    "productCode": "218004030000",
    "name": "Aurora Genesis Card #001",
    "claimed": false,
    "claimedStatus": "UNCLAIMED",
    "state": "ACTIVE",
    "owner": null,
    "ledgerLength": 1,
    "verifiedAt": "2026-07-23T10:43:29.723Z"
  }
}
```

## Ledger

### ✅ #5 Ledger before claim (First Time origin record, HitBox)

`GET /api/v1/ledger/E2ETAG0000001` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ 1 origin row
- ✅ seq0 MINT, owner=HitBox
- ✅ claimHistory=No, p2p=No
- ✅ productId(12) + tag present
- ✅ hash = SHA256(productId+tag+owner+dateTime)

Response:

```json
{
  "data": [
    {
      "sequenceNo": 0,
      "txType": "MINT",
      "productId": "218004030000",
      "tag": "E2ETAG0000001",
      "ownerId": "HitBox",
      "dateTime": "2026-07-23T10:43:29.563Z",
      "hash": "674a3cea350a05fc06002d38070666e49607a2589e22a5cb705fbebb98db8f91",
      "previousHash": null,
      "claimHistory": false,
      "peerToPeerTrading": false
    }
  ]
}
```

## Products

### ✅ #6 History before claim (empty)

`GET /api/v1/products/tag/E2ETAG0000001/history` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ empty

Response:

```json
{
  "data": []
}
```

## Claim flow

### ✅ #7 First tap — jameela claims (unclaimed → CLAIMED)

`POST /api/v1/claim/E2ETAG0000001` — as **jameela** → **200** (expected 200)

Request body:

```json
{
  "visibility": "PUBLIC"
}
```

Checks:

- ✅ status 200
- ✅ outcome CLAIMED
- ✅ claimedByYou true
- ✅ owner = jameela
- ✅ claim.claimCode HBPC######
- ✅ message says "You claimed"

Response:

```json
{
  "data": {
    "outcome": "CLAIMED",
    "claimedByYou": true,
    "message": "You claimed \"Aurora Genesis Card #001\". You now own it.",
    "owner": {
      "id": "cmrxdv8lf0000epsoevomqncn",
      "username": "jameela",
      "displayName": "jameela"
    },
    "product": {
      "id": "cmrxdv8nu0002epsok6gvz8o6",
      "productCode": "218004030000",
      "name": "Aurora Genesis Card #001",
      "tagId": "E2ETAG0000001",
      "claimedStatus": "CLAIMED"
    },
    "claimedAt": "2026-07-23T10:43:29.779Z",
    "claim": {
      "id": "cmrxdv8u40007epsojvirsa00",
      "claimCode": "HBPC009938",
      "claimedNo": 1
    }
  }
}
```

### ✅ #8 Re-tap by akash (already claimed → shows owner name)

`POST /api/v1/claim/E2ETAG0000001` — as **akash** → **200** (expected 200)

Request body:

```json
{}
```

Checks:

- ✅ status 200
- ✅ outcome ALREADY_CLAIMED
- ✅ claimedByYou false
- ✅ owner reported = jameela
- ✅ message names the owner
- ✅ no claim record returned

Response:

```json
{
  "data": {
    "outcome": "ALREADY_CLAIMED",
    "claimedByYou": false,
    "message": "\"Aurora Genesis Card #001\" is already claimed by jameela.",
    "owner": {
      "id": "cmrxdv8lf0000epsoevomqncn",
      "username": "jameela",
      "displayName": "jameela"
    },
    "product": {
      "id": "cmrxdv8nu0002epsok6gvz8o6",
      "productCode": "218004030000",
      "name": "Aurora Genesis Card #001",
      "tagId": "E2ETAG0000001",
      "claimedStatus": "CLAIMED"
    },
    "claimedAt": "2026-07-23T10:43:29.779Z",
    "claim": null
  }
}
```

### ✅ #9 Re-tap by jameela herself (already own)

`POST /api/v1/claim/E2ETAG0000001` — as **jameela** → **200** (expected 200)

Request body:

```json
{}
```

Checks:

- ✅ status 200
- ✅ outcome ALREADY_CLAIMED
- ✅ claimedByYou true
- ✅ message says "You already own"

Response:

```json
{
  "data": {
    "outcome": "ALREADY_CLAIMED",
    "claimedByYou": true,
    "message": "You already own \"Aurora Genesis Card #001\".",
    "owner": {
      "id": "cmrxdv8lf0000epsoevomqncn",
      "username": "jameela",
      "displayName": "jameela"
    },
    "product": {
      "id": "cmrxdv8nu0002epsok6gvz8o6",
      "productCode": "218004030000",
      "name": "Aurora Genesis Card #001",
      "tagId": "E2ETAG0000001",
      "claimedStatus": "CLAIMED"
    },
    "claimedAt": "2026-07-23T10:43:29.779Z",
    "claim": null
  }
}
```

## Verify

### ✅ #10 Verify after claim (owner = jameela)

`GET /api/v1/verify/E2ETAG0000001` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ claimed true
- ✅ owner = jameela
- ✅ ledgerLength 2 (MINT+CLAIM)

Response:

```json
{
  "data": {
    "valid": true,
    "productId": "cmrxdv8nu0002epsok6gvz8o6",
    "productCode": "218004030000",
    "name": "Aurora Genesis Card #001",
    "claimed": true,
    "claimedStatus": "CLAIMED",
    "state": "ACTIVE",
    "owner": {
      "id": "cmrxdv8lf0000epsoevomqncn",
      "username": "jameela",
      "displayName": "jameela"
    },
    "ledgerLength": 2,
    "verifiedAt": "2026-07-23T10:43:29.843Z"
  }
}
```

## Ledger

### ✅ #11 Ledger after claim (origin + claim record, per spec)

`GET /api/v1/ledger/E2ETAG0000001` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ 2 rows
- ✅ seq0 MINT owner=HitBox, claimHistory=No, p2p=No
- ✅ seq1 CLAIM owner=jameela, claimHistory=Yes, p2p=Yes
- ✅ same productId + tag on both rows
- ✅ origin hash = SHA256(productId+tag+owner+dateTime)
- ✅ claim hash = SHA256(productId+tag+owner+dateTime)
- ✅ chain link: seq1.previousHash == seq0.hash

Response:

```json
{
  "data": [
    {
      "sequenceNo": 0,
      "txType": "MINT",
      "productId": "218004030000",
      "tag": "E2ETAG0000001",
      "ownerId": "HitBox",
      "dateTime": "2026-07-23T10:43:29.563Z",
      "hash": "674a3cea350a05fc06002d38070666e49607a2589e22a5cb705fbebb98db8f91",
      "previousHash": null,
      "claimHistory": false,
      "peerToPeerTrading": false
    },
    {
      "sequenceNo": 1,
      "txType": "CLAIM",
      "productId": "218004030000",
      "tag": "E2ETAG0000001",
      "ownerId": "jameela",
      "dateTime": "2026-07-23T10:43:29.779Z",
      "hash": "02121854d5e34c17e45953a30e4c7b23e1ed4af01c208371b8f2522ca173df04",
      "previousHash": "674a3cea350a05fc06002d38070666e49607a2589e22a5cb705fbebb98db8f91",
      "claimHistory": true,
      "peerToPeerTrading": true
    }
  ]
}
```

## Products

### ✅ #12 History after claim (1 open period, jameela)

`GET /api/v1/products/tag/E2ETAG0000001/history` → **200** (expected 200)

Checks:

- ✅ status 200
- ✅ 1 period
- ✅ owner=jameela, open

Response:

```json
{
  "data": [
    {
      "id": "cmrxdv8uc000bepsovncjfw3l",
      "price": "49.99",
      "ownershipStartDate": "2026-07-23T10:43:29.779Z",
      "ownershipEndDate": null,
      "ownerId": "cmrxdv8lf0000epsoevomqncn"
    }
  ]
}
```

## Errors

### ✅ #13 Claim unknown tag → 404

`POST /api/v1/claim/NOSUCHTAG` — as **jameela** → **404** (expected 404)

Checks:

- ✅ status 404
- ✅ code TAG_NOT_FOUND

Response:

```json
{
  "error": {
    "code": "CLAIMS_TAG_NOT_FOUND",
    "message": "No product is registered to this NFC tag"
  }
}
```

### ✅ #14 Verify unknown tag → 404

`GET /api/v1/verify/NOSUCHTAG` → **404** (expected 404)

Checks:

- ✅ status 404
- ✅ code TAG_NOT_FOUND

Response:

```json
{
  "error": {
    "code": "CLAIMS_TAG_NOT_FOUND",
    "message": "No product is registered to this NFC tag"
  }
}
```

### ✅ #15 Claim without auth → 401

`POST /api/v1/claim/E2ETAG0000001` → **401** (expected 401)

Checks:

- ✅ status 401
- ✅ code UNAUTHENTICATED

Response:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication required"
  }
}
```

### ✅ #16 Create product missing name → 422

`POST /api/v1/products` — as **jameela** → **422** (expected 422)

Request body:

```json
{
  "type": "INDIVIDUAL",
  "category": "OTHER",
  "genre": "OTHER"
}
```

Checks:

- ✅ status 422
- ✅ code VALIDATION_ERROR

Response:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "path": "name",
        "message": "Required"
      }
    ]
  }
}
```

