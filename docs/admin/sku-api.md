# Product Upload & SKU Unit APIs

> Creating a drop together with its serialized edition, minting more units
> later, and reading those units back — per drop and one at a time.
>
> How much of a unit you get back depends on **your grants**, not on the
> endpoint. Section 6 is the matrix.
>
> Creating the drop itself, the accepted request formats (and the `422`
> troubleshooting table), and the image gallery:
> [product-upload-api.md](product-upload-api.md).
> Session handling and the Clerk flow: [authentication.md](authentication.md).
> The rest of the admin write surface: [admin-write-apis.md](admin-write-apis.md).
> Screen-by-screen reference: [admin-console-api.md](admin-console-api.md).

---

## 1. The two things being created

These are two different records and conflating them is the most common
integration mistake:

| | `Product` (catalog) | `Sku` (serialized unit) |
|---|---|---|
| Owned by | `@hitbox/products` | `@hitbox/skus` |
| Means | "this drop exists and here is what it is" | "this **physical object** exists" |
| Identified by | `groupCode` — `123456780000` | `skuCode` — `123456780000-000014` |
| Quantity | one row per drop | one row per item, `#1 … #totalSupply` |
| Carries | name, artwork, price, release window | serial, NFC tag UID, owner, provenance |

`Product.totalSupply` is a **declaration** — "this edition will be 500". The
number of `Sku` rows is the **fact**. They are allowed to disagree while an
edition is being minted, and the API tells you the gap (`remainingSupply`).

A unit's ownership history is not written here. The claims module appends the
`MINT` row of a unit's hash chain on first use, so minting stays a catalog
operation and the ledger stays append-only under a single owner.

---

## 2. `POST /api/v1/admin/products` — upload a drop, with its edition

The wizard's single submit. Creates the catalog record and, when `skus` is
present, mints the edition **in the same transaction** — so the request either
produces a drop with N units or produces nothing at all.

**Capability:** `drop:manage` at `GLOBAL` scope (`globalOnly`). See
[admin-write-apis.md 0](admin-write-apis.md).

### Request

```http
POST /api/v1/admin/products
Authorization: Bearer <clerk session token>
Content-Type: application/json
```

```json
{
  "name": "Neon Drift — Series 2",
  "description": "Hand-finished resin figure, 500 piece edition.",
  "vertical": "figures",
  "category": "collectible",
  "rarity": "limited",
  "artistId": "6b5f3a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  "organizationId": "9f8e7d6c-5b4a-3928-1706-fedcba987654",
  "totalSupply": 500,
  "purchaseLimit": 2,
  "releaseStart": "2026-10-01T09:00:00.000Z",
  "releaseEnd": "2026-10-08T09:00:00.000Z",
  "isAgeSpecific": false,
  "groupCode": "0042",

  "prices": [{ "marketCode": "IN", "amount": "1999.00" }],
  "skus": { "count": 500 }
}
```

`prices` is **required** — at least one market price, or the create is a
`422`. See [product-upload-api.md 3](product-upload-api.md).

| Field | Type | Notes |
|---|---|---|
| `name` | string, 1–255 | required |
| `totalSupply` | int ≥ 0 | default `0` = "size not declared yet" |
| `groupCode` | 4 digits | the **group suffix**; the server prefixes 8 random digits |
| `status` | `DropStatus` | defaults to `DRAFT`; the releases module drives the rest |
| `skus.count` | int 1–1000 | omit the whole block to create a catalog entry with no units |
| `prices[]` | 1–200 entries | **required** — one price per market |
| `images[]` | ≤24 entries | attaches uploaded assets as the gallery — [product-upload-api.md 4](product-upload-api.md) |

The full field table, and what the body may look like on the wire, are in
[product-upload-api.md 2](product-upload-api.md).

`vertical`, `category` and `rarity` are free-form strings, not enums — the
columns are `String?` and a fixed list kept only in TypeScript would be a
second source of truth that drifts.

### There is deliberately no `tagIds` here

Binding a physical NFC tag requires `nfc-tag-claim:manage`. This route checks
`drop:manage`. A payload that bound tags here would let a caller write to the
one table the platform's authenticity guarantee rests on without ever holding
the capability that governs it. Bind tags through 3a, which checks for it.

There is no `skus.variantId` either: a drop being created has no variants yet,
so any id supplied would necessarily belong to a *different* product — and the
foreign key would accept it. Mint per variant through 3.

### Response `201`

The full product body (identical to `GET /admin/products/:id`) plus a `skus`
block when units were minted:

```json
{
  "data": {
    "id": "0f1e2d3c-4b5a-6978-8766-554433221100",
    "groupCode": "123456780042",
    "name": "Neon Drift — Series 2",
    "status": "DRAFT",
    "complianceStatus": "PENDING",
    "totalSupply": 500,
    "images": [],
    "price": null,
    "variants": [],
    "skus": {
      "minted": 500,
      "firstSerial": 1,
      "lastSerial": 500,
      "skuCodes": ["123456780042-000001", "… 498 more …", "123456780042-000500"],
      "tagsBound": 0
    }
  }
}
```

The `skus` key is **absent** when no `skus` block was sent. It is not `null`.

### Why 1000 is the inline cap

This insert runs inside the transaction that also creates the `Product`, and a
transaction writing 10,000 rows holds locks long enough to matter. Larger
editions are minted in batches through 3 — the same code path without a
product write attached.

---

## 3. `POST /api/v1/admin/products/:productId/skus` — mint units

Appends to an existing drop's edition. Serials continue from the highest one
already minted, so calling this three times with `count: 100` yields
`#1–100`, `#101–200`, `#201–300`.

**Capability:** `collectible-instance:manage`, checked against the **drop's own
organization**. Not `globalOnly` — a Brand Admin holding
`collectible-instance:manage:organization` mints the edition for a drop they
own, and the engine confines them to it.

**Binding tags additionally requires `nfc-tag-claim:manage`.**

### Request

```json
{
  "count": 3,
  "variantId": null,
  "tagIds": ["04:A3:9B:2C:5D:6E:80", "04A39B2C5D6E81", "04-A3-9B-2C-5D-6E-82"],
  "vendorId": "11112222-3333-4444-5555-666677778888",
  "provisioningBatchId": "BATCH-2026-09-41",
  "isActive": true
}
```

| Field | Type | Notes |
|---|---|---|
| `count` | int 1–1000 | required |
| `tagIds` | string[] | hex, `:`/`-`/space separators allowed. **Exactly `count` entries or omit entirely** |
| `vendorId` | uuid | who provisioned the tags |
| `provisioningBatchId` | string | recorded, not verified — tags routinely arrive before the supply row exists |
| `isActive` | boolean | default `true`; mint `false` to stage units ahead of a release |

**Tag normalisation:** separators are stripped and the value upper-cased before
storage, so `04:A3:9B…`, `04-a3-9b…` and `04A39B…` are the same tag. `Sku.tagId`
is unique platform-wide, and that uniqueness is the primary defence against
cloned tags — it only works if the stored form is canonical.

**Why `tagIds` must be exactly `count` long:** a shorter list would silently
leave the tail of the batch untagged, and "silently" is not a property you want
in the table that proves authenticity.

### Response `201`

```json
{
  "data": {
    "productId": "0f1e2d3c-4b5a-6978-8766-554433221100",
    "minted": 3,
    "firstSerial": 501,
    "lastSerial": 503,
    "skuCodes": [
      "123456780042-000501",
      "123456780042-000502",
      "123456780042-000503"
    ],
    "tagsBound": 3
  }
}
```

Units are created `UNCLAIMED`, with `tagLifecycleState` of `BOUND` when a tag
was supplied and `UNPROVISIONED` otherwise. `ACTIVE` is reached on first claim,
by the claims module — never here.

### Concurrency

Two operators minting the tail of the same edition at once is ordinary. The
serial range is read and written inside one transaction, and the loser of the
race gets a `P2002` on `@@unique([productId, serialNumber])`, is retried
automatically with a fresh high-water mark, and lands on the next block. You
will not see an error unless five attempts fail in a row.

The supply cap is enforced **inside** the same transaction. Checked outside it,
two callers each see 400 of 500 minted and each mint 100, and the edition
quietly becomes 600 — in a table whose entire purpose is to say how many of a
thing exist.

---

## 3a. "I'm minting 500 units — how do 500 different tag IDs get in?"

**Not through the mint call.** Passing 500 UIDs to `POST .../skus` requires
knowing all 500 *before a single unit exists*, which is not how tag
provisioning works: the units are minted when the drop is planned, and the
physical tags arrive later, in boxes, with a manifest.

So there are two paths, and for anything past a handful of units you want the
second.

### Path A — tags in hand at mint time (small batches)

Pass `tagIds` alongside `count`, exactly as long as `count` (3). Fine for 10
units. For 500 it means a 500-element array in one request body, and it is
impossible past 1000 because that is the batch cap.

### Path B — mint bare, bind from the manifest (the normal path)

```
1. POST /admin/products/:id/skus        { "count": 500 }
      → 500 units, UNPROVISIONED, no tags
2.   … tags are manufactured and shipped …
3. POST /admin/products/:id/skus/tags   { "bindings": [ … ] }
      → units become BOUND
```

Step 1 and step 3 are days or weeks apart, which is the point.

### `POST /api/v1/admin/products/:productId/skus/tags`

**Capability: `nfc-tag-claim:manage`** — deliberately *not* the minting
capability. A Drop Manager mints the edition; whoever holds tag custody binds
the tags. Today only `HITBOX_SYSTEM_ADMIN` holds it.

The body is a direct translation of a vendor CSV (`serial,tagId` per line),
because that is what actually arrives with a box of tags:

```json
{
  "bindings": [
    { "serialNumber": 1, "tagId": "04:A3:9B:2C:5D:6E:80" },
    { "serialNumber": 2, "tagId": "04-a3-9b-2c-5d-6e-81" },
    { "serialNumber": 3, "tagId": "04a39b2c5d6e82" }
  ],
  "vendorId": "11112222-3333-4444-5555-666677778888",
  "provisioningBatchId": "BATCH-2026-09-41",
  "replace": false
}
```

| Field | Notes |
|---|---|
| `bindings[].serialNumber` | position in the edition — **or** |
| `bindings[].skuCode` | the full code. Exactly one of the two per row |
| `bindings[].tagId` | hex, any separator style |
| `vendorId` / `provisioningBatchId` | applied to every unit in the batch |
| `replace` | allow overwriting a tag already bound. Default `false` |

Up to **1000 bindings per call**. A 10,000-unit edition is ten calls.

```json
{
  "data": {
    "productId": "0f1e2d3c-…",
    "bound": 3,
    "items": [
      { "skuCode": "123456780042-000001", "serialNumber": 1, "tagId": "04A39B2C5D6E80", "replaced": false },
      { "skuCode": "123456780042-000002", "serialNumber": 2, "tagId": "04A39B2C5D6E81", "replaced": false },
      { "skuCode": "123456780042-000003", "serialNumber": 3, "tagId": "04A39B2C5D6E82", "replaced": false }
    ]
  }
}
```

### Five rules that make this safe

**1. Tags are normalised before anything else.** `04:A3:9B:…`, `04-a3-9b-…`
and `04a39b…` are one tag, stored as `04A39B…`. `Sku.tagId` is unique
platform-wide and that index is the primary defence against cloned tags — it
only works if the stored form is canonical. A batch containing the same
physical tag under two spellings is rejected as a duplicate.

**2. The batch is all-or-nothing.** One transaction. A half-applied manifest
leaves a box of physical tags in a state nobody can reconcile from the
database — working out which of 500 items got written is a warehouse problem.

**3. Every problem is reported at once.** The manifest is applied by a person
with a box in front of them; telling them about one bad row per request is 40
round trips.

```json
{ "error": {
    "code": "SKUS_UNIT_NOT_IN_PRODUCT",
    "message": "Manifest rejected: #501: not a unit of this drop; #14: already bound to 04A39B2C5D6E77; send replace: true to overwrite",
    "details": null } }
```

**4. Re-sending an identical binding is a no-op, not an error.** Retrying a
timed-out manifest is safe.

**5. Re-tagging a claimed unit is refused.** Even with `replace: true`, a unit
whose `claimedStatus` is `CLAIMED` is refused unless its tag is already marked
`LOST`, `REVOKED` or `DISPUTED`. The owner's app and the unit's hash chain are
keyed to the tag it was claimed with; swapping it under a live owner silently
breaks verification for the person holding the object. Mark the old tag lost
first — that is what those states are for.

```json
{ "error": {
    "code": "SKUS_TAG_REPLACE_REFUSED",
    "message": "123456780042-000014: is claimed and its tag is ACTIVE; mark the tag LOST, REVOKED or DISPUTED before re-tagging",
    "details": null } }
```

### `PATCH /api/v1/admin/skus/:skuId/tag`

One unit, same rules. For the single-item case — a chip failed, an item was
re-tagged after repair.

```json
{ "tagId": "04A39B2C5D6E99", "replace": true, "provisioningBatchId": "BATCH-2026-10-02" }
```

Returns the full unit detail, shaped for your grants (6).

### Tracking progress

`GET /admin/products/:id/skus/summary` reports `tagged` / `untagged`, and
`GET /admin/products/:id/skus?tagged=false` lists exactly the units still
waiting for one. That pair is how an operator drives a partial rollout.

---

## 4. Reading units, per drop

### `GET /api/v1/admin/products/:productId/skus`

**Capability:** `collectible-instance:read`, against the drop's organization.
(`manage` satisfies `read`, so every role holding `collectible-instance:manage`
qualifies without listing both.)

| Query param | Type | Default | Notes |
|---|---|---|---|
| `page` / `limit` | int | `1` / `50` | `limit` max `200` |
| `claimedStatus` | `UNCLAIMED` \| `CLAIMED` \| `IN_TRANSFER` \| `FLAGGED` | — | |
| `tagLifecycleState` | `UNPROVISIONED` \| `BOUND` \| `ACTIVE` \| `LOST` \| `REVOKED` \| `DISPUTED` | — | |
| `variantId` | uuid | — | |
| `tagged` | boolean | — | `true` = has a tag bound, `false` = awaiting one |
| `resaleBlocked` | boolean | — | |
| `includeArchived` | boolean | `false` | |
| `search` | string | — | matches serial number, `skuCode` fragment, or a full tag UID |
| `sort` | `serial_asc` \| `serial_desc` \| `newest` | `serial_asc` | |

A digits-only `search` term is matched against the serial number as well as the
code, because an operator holding the physical item reads "#14" off the card,
not `123456780042-000014`.

**Response** — this is a **System Admin** view; see 6 for what other roles get:

```json
{
  "data": [
    {
      "skuId": "aa11bb22-cc33-dd44-ee55-ff6677889900",
      "skuCode": "123456780042-000014",
      "serialNumber": 14,
      "claimedStatus": "CLAIMED",
      "variantId": null,
      "isActive": true,
      "archivedAt": null,
      "createdAt": "2026-09-15T10:04:22.118Z",
      "trust": {
        "resaleBlocked": false,
        "resaleBlockedReason": null,
        "tamperStatus": null
      },
      "tag": {
        "tagId": "04A39B2C5D6E80",
        "tagLifecycleState": "ACTIVE",
        "lastTapCounter": 7
      },
      "owner": {
        "ownerId": "77889900-aabb-ccdd-eeff-001122334455",
        "email": "jane.doe@example.com",
        "handle": "janedrifts"
      }
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 500, "totalPages": 10 }
}
```

### `GET /api/v1/admin/products/:productId/skus/summary`

The header row of the drop's inventory screen. Both breakdowns are read
together so the two views of the same population cannot disagree on the total.

```json
{
  "data": {
    "productId": "0f1e2d3c-4b5a-6978-8766-554433221100",
    "total": 503,
    "byClaimedStatus": { "UNCLAIMED": 480, "CLAIMED": 22, "FLAGGED": 1 },
    "byTagLifecycleState": { "UNPROVISIONED": 200, "BOUND": 281, "ACTIVE": 22 },
    "tagged": 303,
    "untagged": 200,
    "remainingSupply": 0
  }
}
```

`remainingSupply` is `null` when `totalSupply` is `0` (undeclared), not `0` —
"no cap set" and "cap reached" are different facts.

`byTagLifecycleState`, `tagged` and `untagged` are **omitted entirely** for a
caller without `nfc-tag-claim`.

---

## 5. Reading one unit

### `GET /api/v1/admin/skus/:skuId`
### `GET /api/v1/admin/skus/code/:skuCode`

Same response. Prefer the `code` form from an operator's hands: the code is
printed on the item, the UUID is not written anywhere physical.

```json
{
  "data": {
    "skuId": "aa11bb22-cc33-dd44-ee55-ff6677889900",
    "skuCode": "123456780042-000014",
    "serialNumber": 14,
    "claimedStatus": "CLAIMED",
    "variantId": null,
    "isActive": true,
    "archivedAt": null,
    "createdAt": "2026-09-15T10:04:22.118Z",

    "product": {
      "productId": "0f1e2d3c-4b5a-6978-8766-554433221100",
      "groupCode": "123456780042",
      "name": "Neon Drift — Series 2",
      "organizationId": "9f8e7d6c-5b4a-3928-1706-fedcba987654",
      "status": "ACTIVE",
      "totalSupply": 500
    },

    "trust":  { "resaleBlocked": false, "resaleBlockedReason": null, "tamperStatus": null },
    "tag":    { "tagId": "04A39B2C5D6E80", "tagLifecycleState": "ACTIVE", "lastTapCounter": 7 },
    "owner":  { "ownerId": "7788…", "email": "jane.doe@example.com", "handle": "janedrifts" },

    "provenance": {
      "claimCount": 1,
      "ledgerEntries": 2,
      "firstClaimedAt": "2026-10-02T14:31:09.400Z",
      "currentHolderSince": "2026-10-02T14:31:09.400Z",
      "currentHolderPaid": { "amount": "149.00", "currency": "USD" }
    },

    "commerce": {
      "allocatedOrderId": "33445566-7788-99aa-bbcc-ddeeff001122",
      "allocatedOrderStatus": "DELIVERED",
      "reservationStatus": "COMMITTED",
      "amount": "149.00",
      "currency": "USD"
    }
  }
}
```

**`claimToken` is never returned to anyone**, at any visibility. It is a
single-use token that is burned on claim; a live one in a response body is a
claim someone else can make. It is not selected from the database at all.

### `GET /api/v1/admin/skus`

The same list shape as 4, across every drop. Carries no product in its path,
so there is no organization to check against and **only a grant with global
breadth matches** — organization-scoped callers get `403` here and reach their
units through `/admin/products/:productId/skus` instead.

---

## 6. Which roles see how much

Two separate questions, and the API answers them separately:

1. **Can you reach the endpoint at all?** — `collectible-instance:read`.
2. **How much of each unit comes back?** — resolved per request from *all* of
   the caller's grants.

A SKU row carries three different secrets with three different audiences, so
each is gated by its own resource rather than by one "can you see SKUs" flag:

| Block | Gated by | Contains |
|---|---|---|
| *(identity)* | always present | `skuId`, `skuCode`, `serialNumber`, `claimedStatus`, `variantId`, `isActive`, `createdAt` |
| `trust` | `collectible-instance` at **FULL** | `resaleBlocked`, `resaleBlockedReason`, `tamperStatus` |
| `tag` | `nfc-tag-claim` | `tagId`, `tagLifecycleState`, `lastTapCounter` (FULL only) |
| `owner` | `buyer-profile` | `ownerId`, `email`, `handle` |
| `provenance` | `nfc-tag-claim` | claim count, ledger length, holder timestamps |
| `commerce` | `order` | allocated order, reservation status |
| *money inside either* | **additionally** `payment-royalty` | `currentHolderPaid`, `amount`, `currency` |

That last row is the rule worth internalising: **`order:read` never implies
financial visibility.** A caller who can see that unit #14 belongs to order
`3344…` may still not see what it sold for.

### The matrix

| Role | Reaches endpoints | Unit scope | `trust` | `tag` | `owner` | `commerce` | Money | Can bind tags |
|---|---|---|---|---|---|---|---|---|
| `HITBOX_SYSTEM_ADMIN` | ✅ | all drops | ✅ | ✅ full | ✅ full | ✅ | ✅ | ✅ |
| `HITBOX_DROP_MANAGER` | ✅ | all drops | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `HITBOX_SUPPORT` | ✅ | all drops | ❌ *(masked)* | ✅ full | ✅ `***@***` | ✅ | ❌ | ❌ |
| `BRAND_ADMIN` | ✅ | own org only | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `BRAND_EMPLOYEE` | ✅ | own org only | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `ARTIST` | ✅ | own org only | ✅ | ❌ | ❌ | ❌ | ✅ *(own)* | ❌ |
| `HITBOX_ORDER_MANAGER` | ❌ `403` | — | — | — | — | — | — | — |
| `HITBOX_CONTENT_MANAGER` | ❌ `403` | — | — | — | — | — | — | — |
| `HITBOX_FINANCE_ADMIN` | ❌ `403` | — | — | — | — | — | — | — |
| `BUYER_COLLECTOR` | ❌ `403` | — | — | — | — | — | — | — |
| technical roles | ❌ `403` | — | — | — | — | — | — | — |

This table is asserted by
`packages/skus/tests/sku-access.test.ts`, which reads the **seeded role
catalog** rather than hand-written permission lists — so a future edit to a
role's grants fails a test instead of silently changing what an operator sees.

### The four results worth explaining

**A Brand Admin sees every unit of their own drop and not one tag UID.**
Brands hold `collectible-instance:manage:organization` and no `nfc-tag-claim`
grant at all. This is intended: brands own the edition, HitBox owns the
anti-counterfeiting material. A tag UID that leaks is a tag that can be written
to a blank chip.

**A Drop Manager can mint 500 units of any drop on the platform and cannot bind
a single tag.** Same reason, from the other direction — which is the whole point
of keeping `nfc-tag-claim` a resource separate from the unit it describes.

**Support gets real tag UIDs but masked buyers.** They resolve tag disputes, so
they need the UID; they have no business knowing whose house it is in. There is
no unmask path for this role. They also lose the `trust` block — their
`collectible-instance` grant is `:masked`, and investigation notes are not
theirs to read.

**A buyer is refused, and that took a deliberate check.** `BUYER_COLLECTOR`
holds `collectible-instance:read:public`, and `PUBLIC` scope has *ALL* breadth —
so a bare `requirePermission('collectible-instance:read')` on an admin route
admits every signed-in buyer on the platform. The route guard cannot tell the
difference, because a grant did match. `buildSkuAccess()` refuses `PUBLIC` and
`OWN` visibility explicitly, after looking at the **scope of the grant that
matched** rather than at the fact that one did.

### Absent key ≠ empty value

A block the caller may not see is **omitted from the JSON entirely**. It is
never `null` and never `{}`.

```jsonc
// Drop Manager — no `owner` key at all
{ "skuCode": "…-000014", "claimedStatus": "CLAIMED", "trust": { … } }

// System Admin, unit genuinely unclaimed — key present, values null
{ "skuCode": "…-000015", "claimedStatus": "UNCLAIMED",
  "owner": { "ownerId": null, "email": null, "handle": null } }
```

A client that renders "Owner: —" for both has lost the distinction that
matters. Render an absent block as *nothing* — no label, no row, no empty
state. Use `'owner' in sku` to tell them apart.

### Two gaps in the seeded catalog

Both are properties of `role-catalog.ts`, not of this module, and both are
pinned by tests so that changing them is deliberate:

- **`HITBOX_ORDER_MANAGER` holds no `collectible-instance` grant**, so it is
  refused here. It still sees the allocated unit of an order through the orders
  module, which gates on `order:read`. If order managers should be able to look
  up a unit directly, add `collectible-instance:read:masked-partial` to that
  role.
- **`HITBOX_CONTENT_MANAGER` holds `collectible-instance:update:global`** — it
  can update a unit it cannot read, because `update` does not imply `read`
  (only `manage` does, per `ACTION_IMPLIES`). If that role is meant to reach
  these endpoints, the grant should be `:manage` rather than `:update`.

---

## 7. Errors

All errors use the platform envelope:

```json
{ "error": { "code": "…", "message": "…", "details": null } }
```

| HTTP | `code` | Raised when |
|---|---|---|
| `400` | `SKUS_VARIANT_MISMATCH` | `variantId` belongs to a different product |
| `400` | `PRODUCTS_MINTING_UNAVAILABLE` | a `skus` block arrived but no minting provider is wired in |
| `400` | `PRODUCTS_SUPPLY_EXCEEDED` | `skus.count` exceeds the drop's own `totalSupply` in the same payload |
| `401` | `AUTH_*` | missing or invalid session token |
| `403` | `SKUS_FORBIDDEN` | reached the route but holds no operator-grade `collectible-instance` grant — or sent `tagIds` without `nfc-tag-claim:manage` |
| `403` | `AUTHZ_FORBIDDEN` | the route's capability check failed outright |
| `404` | `SKUS_NOT_FOUND` | no such unit, **or** it belongs to a drop outside your organization |
| `404` | `SKUS_PRODUCT_NOT_FOUND` | no such drop, **or** outside your organization |
| `409` | `SKUS_SUPPLY_EXCEEDED` | minting would push the edition past `totalSupply` |
| `409` | `SKUS_TAG_TAKEN` | an NFC tag UID is already bound to another unit |
| `409` | `SKUS_SERIAL_TAKEN` | five consecutive serial-range collisions |
| `409` | `SKUS_UNIT_NOT_IN_PRODUCT` | a manifest row names a unit that is not in this drop |
| `409` | `SKUS_TAG_ALREADY_BOUND` | the unit carries a tag and `replace` was not set |
| `409` | `SKUS_TAG_REPLACE_REFUSED` | re-tagging a claimed unit whose tag is still healthy |
| `422` | `VALIDATION_ERROR` | schema failure — e.g. `tagIds` length ≠ `count` |

**Out-of-scope records return `404`, not `403`.** A `403` confirms the id
exists, which is itself a fact about another brand's catalog.

`SKUS_TAG_TAKEN` names the conflicts so the operator can find the tag:

```json
{ "error": {
    "code": "SKUS_TAG_TAKEN",
    "message": "Already bound to another unit: 04A39B2C5D6E80 → 123456780011-000007",
    "details": null } }
```

---

## 8. Integration notes

**Minting a 5,000-unit edition.** Create the drop with `totalSupply: 5000` and
no `skus` block, then call 3 five times with `count: 1000`. Each call reports
its own `firstSerial`/`lastSerial`; poll `/skus/summary` for progress. Do not
run the batches in parallel — they will collide on the serial range, and while
the retry handles it correctly, serialised calls are faster.

**Binding tags to already-minted units** is the normal path for any edition
past a handful — mint bare, then apply the vendor manifest. See 3a.

**Rendering an inventory table.** Read `/skus/summary` for the header counts and
`/skus?page=…` for the rows — the summary is a single grouped query and is much
cheaper than counting a paged list client-side.

**Deciding which columns to render.** Do not branch on role names. Branch on
the presence of the block: `'tag' in sku`, `'owner' in sku`. The response is
already shaped for the caller, and a client that infers columns from a role
name will be wrong the moment an operator defines a new role.

---

## 9. Not built

| Gap | Note |
|---|---|
| Change a tag's lifecycle state | No endpoint sets `LOST` / `REVOKED` / `DISPUTED`, which means the re-tag path in 3a rule 5 cannot currently be unblocked for a claimed unit. This is the most useful next addition |
| Block / unblock resale on a unit | `resaleBlocked` + `resaleBlockedReason` are readable and set to `false` at mint; nothing writes them |
| Archive a unit | `Sku.archivedAt` is readable and filterable; nothing sets it |
| Transfer ownership administratively | ownership moves only through the claims module today |
| Link a binding to a `SupplyBatch` | `provisioningBatchId` is a free-text reference, not a foreign key — the `supply` module owns `SupplyBatch` and nothing joins the two |
