# Admin Write APIs — Markets, Orders, Products, Releases, Media, Roles & Team

> The administrative **write** surface: everything that changes state rather
> than reporting it. Added alongside the read-only dashboard documented in
> [admin-console-api.md](admin-console-api.md).
>
> Session handling and the Clerk flow: [authentication.md](authentication.md).
> Endpoint-by-module reference: [admin-api-reference.md](admin-api-reference.md).

---

## 0. How "System Admin only" is enforced

You asked for several of these to be System-Admin-only. There is no role check
anywhere in this backend and there deliberately still isn't — a route that
names `HITBOX_SYSTEM_ADMIN` breaks the moment someone defines a second
platform-wide role through the Roles screen.

Instead, those routes require the matching capability **at `GLOBAL` scope**:

```ts
requirePermission('drop:manage', { globalOnly: true })
```

`globalOnly` is checked *after* the engine picks the widest grant the caller
holds, so it asks "was the grant that let you through a platform-wide one?"
Today `HITBOX_SYSTEM_ADMIN` is the only role holding these at `:global`, which
gives you exactly the restriction you asked for — and an operator who later
defines `HITBOX_PLATFORM_OPS` with `drop:manage:global` gets the same access
with no code change.

The practical consequence, and the one worth checking against your intent:

| Caller | `drop:manage` scope | Product / market writes |
|---|---|---|
| `HITBOX_SYSTEM_ADMIN` | `:global` | ✅ |
| `HITBOX_DROP_MANAGER` | `:global` | ✅ — **also passes** |
| `BRAND_ADMIN` | `:organization` | ❌ `403` |

Drop Manager holds `drop:manage:global` in the seeded catalog, so it passes the
product and market gates. If that is wrong, the fix is to narrow Drop Manager's
grant in `packages/access-control/src/domain/role-catalog.ts` — not to add a
role check here.

**Error when the scope is too narrow:**

```json
{ "error": { "code": "AUTHZ_FORBIDDEN",
             "message": "This action requires platform-wide administration rights",
             "details": null } }
```

### Gate summary

| Surface | Capability | `globalOnly` |
|---|---|---|
| Market read | `reports-dashboards:read` | no |
| Market create / update / archive | `drop:manage` | **yes** |
| Order read + detail | `order:read` | no |
| Order status change | `order:manage` | no — an org-scoped Order Manager ships their own orders |
| Product admin detail | `drop:read` | no |
| Product create / update / archive | `drop:manage` | **yes** |
| Release read | `release-approval:read` | no |
| Release submit / amend / decide | `release-approval:manage` | no |
| Release **reverse a decision** | `release-approval:override:global` | implicit |
| Media list / archive view | `assets-documents-upload:read` | no |
| Role list + permissions | `employee-role-mgmt:read` | no |
| Role create / update / delete | `employee-role-mgmt:manage` | **yes** |
| Team list | `employee-role-mgmt:read` | no |
| Assign role | `employee-role-mgmt:assign` | no |
| Revoke role | `employee-role-mgmt:delete` | no |

---

## 1. Markets — `/api/v1/admin/markets`

A market is the pricing region a buyer shops in: products carry one
`ProductPrice` per market, orders record the market they were placed in, and
exactly one market is the **default** that a buyer whose country maps nowhere
falls back to.

### `GET /admin/markets`

| Param | Type | Default |
|---|---|---|
| `includeArchived` | boolean | `false` |
| `isActive` | boolean | — |
| `page` / `limit` | int | `1` / `50` (max 200) |

```json
{
  "page": 1, "limit": 50, "total": 4,
  "items": [
    { "id": "5a9e…", "code": "IN", "name": "India", "currency": "INR",
      "isActive": true, "isDefault": true,
      "countryCodes": ["IN", "LK", "NP"],
      "usage": { "productPrices": 340, "orders": 8200 },
      "archivedAt": null,
      "createdAt": "2026-01-04T00:00:00.000Z",
      "updatedAt": "2026-09-01T00:00:00.000Z" }
  ]
}
```

Default market first, then alphabetical by `code`. `usage` is a live reference
count — non-zero `productPrices` means an archive will be refused.

### `GET /admin/markets/:marketId`

`{ "data": MarketResponse }`. `404 MARKETS_NOT_FOUND`.

### `POST /admin/markets` 🔒 platform-wide

```jsonc
{
  "code": "AE",                    // 2–12 chars, upper-cased server-side, unique
  "name": "United Arab Emirates",
  "currency": "USD",               // USD | INR | GBP
  "isActive": true,                // default true
  "isDefault": false,              // default false
  "countryCodes": ["AE", "OM"]     // ISO 3166-1 alpha-2, upper-cased
}
```

→ `201 { "data": MarketResponse }`

### `PATCH /admin/markets/:marketId` 🔒 platform-wide

Same body minus `code`, all fields optional, unknown fields rejected.

> **`code` is immutable.** It is the stable key dashboards and saved reports
> reference; renaming it silently would break every saved view. Create a new
> market instead.

`countryCodes` is **replaced wholesale**, not merged. Send the full list.

### `DELETE /admin/markets/:marketId` 🔒 platform-wide

Soft archive → `200 { "data": MarketResponse }`. Sets `isActive: false`,
`isDefault: false`, `archivedAt`, and frees the country mappings so they can be
remapped to a live market. The row survives because orders reference it and an
order must always be able to name the market it was placed in.

### The three invariants, and the errors they produce

| Code | Status | When |
|---|---|---|
| `MARKETS_CODE_TAKEN` | 409 | `code` already exists |
| `MARKETS_COUNTRY_TAKEN` | 409 | A country is already mapped elsewhere. `details.countryCodes` names them |
| `MARKETS_DEFAULT_REQUIRED` | 400 | Clearing / deactivating / archiving the **default** market |
| `MARKETS_IN_USE` | 409 | Archiving a market with live `ProductPrice` rows. `details.productPrices` gives the count |

**Exactly one default market must exist at all times.** Promoting a market to
default demotes the previous one *in the same transaction* — between two
separate statements the platform would have zero defaults, and any order placed
in that window resolves its market to nothing. You cannot clear the flag on the
only market that has it; promote a different one instead, which moves it
atomically.

---

## 2. Orders — `/api/v1/admin/orders`

### `GET /admin/orders`

| Param | Type | Notes |
|---|---|---|
| `status` | `PENDING_PAYMENT` `PAID` `PROCESSING` `SHIPPED` `DELIVERED` `CANCELLED` `REFUNDED` | |
| `buyerEmail` | string | Partial, case-insensitive. **Requires `buyer-profile:read`** |
| `productCode` | string | Exact match on `Product.groupCode` |
| `marketId`, `organizationId` | uuid | |
| `from`, `to` | ISO date | Half-open on `placedAt` |
| `page` / `limit` | int | `1` / `20` (max 100) |

```jsonc
{
  "page": 1, "limit": 20, "total": 18420,
  "items": [
    {
      "id": "o-1111…", "status": "DELIVERED", "quantity": 3,
      "productId": "p-0003…",
      "productCode": "482910370000",      // was productId-only
      "productName": "Neon Drift #002",
      "variantId": null, "skuId": "sku-402…",
      "marketId": "5a9e…", "organizationId": "org-1…",
      "placedAt": "2026-09-11T05:30:00.000Z",
      "shippedAt": "2026-09-12T…", "deliveredAt": "2026-09-16T…",

      "buyerId": "3f2a9b11-…",            // only with buyer-profile:read
      "buyerEmail": "ana@example.com",    // was buyerId-only
      "buyerName": "Ana Duarte",

      "amount": "448.00",                 // only with payment-royalty:read
      "unitPrice": "149.33", "currency": "USD"
    }
  ]
}
```

### What changed from the dashboard's `/admin/dashboard/orders`

You asked for buyer id → buyer email and product id → product code. Both are
now resolved **at the database**, so a page of 20 orders costs two joins rather
than 40 client-side lookups:

| Was | Now |
|---|---|
| `buyerId` only, truncated to `3f2a9b11…` | `buyerEmail` + `buyerName`, with `buyerId` kept alongside |
| `productId` only | `productCode` (`Product.groupCode`) + `productName`, with `productId` kept |

The ids are still returned because that is what the detail route and every
other API keys on — the additions are for the human reading the table.

> Filtering by `buyerEmail` without `buyer-profile:read` is a **403**, not a
> silently-ignored filter. Otherwise the result count would let a caller who
> may not see buyers confirm that an address exists.

### `GET /admin/orders/:orderId` — full detail

```jsonc
{
  "data": {
    // …every field from the list item, plus:
    "gateway": "STRIPE",
    "trackingNote": "DHL 7741…",
    "termsAcceptedAt": "2026-09-11T05:29:00.000Z",
    "updatedAt": "…", "archivedAt": null,
    "market": { "id": "5a9e…", "code": "IN", "name": "India", "currency": "INR" },

    "skuUnits": [
      { "skuId": "sku-402…", "skuCode": "SKU-0014", "serialNumber": 14,
        "allocation": "ALLOCATED",
        "claimedStatus": "CLAIMED", "tagId": "04A2237FE",
        "tagLifecycleState": "ACTIVE", "ownerId": "u-220…",
        "resaleBlocked": false,
        "reservationId": "ir-9…", "reservationExpiresAt": "2026-09-11T06:29:00.000Z" }
    ],

    "addresses": [
      { "usage": "SHIPPING", "label": "HOME", "labelCustom": null,
        "recipientName": "Ana Duarte", "line1": "…", "line2": null,
        "city": "Mumbai", "state": "MH", "postalCode": "400001",
        "countryCode": "IN", "phone": "+91…" }
    ],

    "allowedTransitions": ["SHIPPED"],

    "payments": [                          // only with payment-royalty:read
      { "id": "pt-1…", "status": "SUCCEEDED", "gateway": "STRIPE",
        "amount": "448.00", "currency": "USD", "createdAt": "…" }
    ],
    "refunds": []                          // only with payment-royalty:read
  }
}
```

#### SKU unit allocation

`skuUnits` is the answer to "which physical items is this order holding". It
merges two sources that represent the same thing at different lifecycle points:

| `allocation` | Means |
|---|---|
| `ALLOCATED` | The SKU is the order's — payment settled (`Order.skuId`, or a `COMMITTED` reservation) |
| `HELD` | A temporary hold while payment is pending; `reservationExpiresAt` is when a sweeper releases it |
| `RELEASED` | The hold expired or the order was cancelled; the unit went back to stock |

They are keyed by SKU with allocation winning over a hold for the same unit, so
an order for quantity 3 with 1 settled and 2 pending renders as **three** rows,
not five. This is what makes "why has this not shipped" answerable.

`allowedTransitions` is precomputed so the UI enables exactly the buttons that
will work, instead of discovering the rule by getting a 400.

### `PATCH /admin/orders/:orderId/status`

```jsonc
{
  "status": "SHIPPED",              // PROCESSING | SHIPPED | DELIVERED | CANCELLED
  "trackingNote": "DHL 7741…",      // optional
  "reason": "Customer requested"    // REQUIRED when status is CANCELLED
}
```

→ `200 { "data": OrderDetail }` — the full refreshed detail, so the screen does
not need a second fetch.

#### The lifecycle graph

```text
PENDING_PAYMENT ──▶ CANCELLED
       │
       ▼ (payments module)
     PAID ──▶ PROCESSING ──▶ SHIPPED ──▶ DELIVERED
       │            │
       ▼            ▼
   CANCELLED    CANCELLED
```

**`PAID` and `REFUNDED` are not settable by hand.** They are written by the
payments and refund pipelines, and an operator typing them would decouple the
order from the transaction that justifies it. They appear as *source* states
only; `REFUNDED` is terminal.

`DELIVERED` is terminal too except for a refund — a delivered order can still
be refunded, it cannot go back to being in transit.

| Code | Status | When |
|---|---|---|
| `ORDERS_STATUS_NOT_SETTABLE` | 400 | Tried to set `PAID` / `REFUNDED` |
| `ORDERS_INVALID_TRANSITION` | 400 | e.g. `DELIVERED → PROCESSING`. `details` carries `{ from, to, allowed[] }` |
| `ORDERS_INVALID_TRANSITION` | 409 | Another operator changed it first — reload and retry |
| `ORDERS_NOT_FOUND` | 404 | Missing **or** out of your scope |

Setting the status it already has is a **no-op returning 200**, not an error —
a double-clicked button should not read as a failure.

`shippedAt` / `deliveredAt` are stamped automatically on entering those states.
The status change is guarded by the order's current status at the database
(`updateMany … WHERE status = from`), so two simultaneous "Mark shipped"
clicks produce one update and one clean 409 rather than a lost write.

---

## 3. Products — `/api/v1/admin/products`

> ⚠ **Security fix included here.** `POST`/`PATCH`/`DELETE /api/v1/products`
> previously sat behind `requireAuth` **alone** — any signed-in buyer could
> create or archive a drop. Those routes have been **removed** from the public
> router and re-mounted here behind a capability. Update any client calling the
> old paths.

`GET /api/v1/products`, `/products/:id` and `/products/code/:groupCode` remain
public and read-only.

### `GET /admin/products/:id` — the detail screen

| Param | Type | Default |
|---|---|---|
| `skuPage` | int | `1` |
| `skuLimit` | int | `50` (max 200) |
| `claimedStatus` | `UNCLAIMED` `CLAIMED` `IN_TRANSFER` `FLAGGED` | — |

```jsonc
{
  "data": {
    // …the full product record (groupCode, name, status, images, price, variants…)

    "performance": {
      "skuTotal": 500,
      "claimed": 310, "unclaimed": 190,
      "reservedHeld": 12, "reservedCommitted": 8,
      "orders": 330,
      "ordersByStatus": { "DELIVERED": 300, "SHIPPED": 20, "PROCESSING": 10 },
      "revenue": { "USD": "49170.00", "INR": "412000.00" },
      "resaleActive": 15,
      "wishlists": 796
    },

    "skuUnits": {
      "page": 1, "limit": 50, "total": 500,
      "items": [
        { "skuId": "sku-402…", "skuCode": "SKU-0014", "serialNumber": 14,
          "variantId": null,
          "claimedStatus": "CLAIMED",
          "ownerId": "u-220…",
          "ownerEmail": "ana@example.com", "ownerHandle": "ana",
          "tagId": "04A2237FE", "tagLifecycleState": "ACTIVE",
          "vendorId": "v-9…",
          "resaleBlocked": false, "resaleBlockedReason": null,
          "tamperStatus": null, "lastTapCounter": 7,
          "isActive": true, "createdAt": "2026-08-01T00:00:00.000Z" }
      ]
    }
  }
}
```

**The six performance counts are read together in one round trip**, not six
sequential queries, because they must agree with each other. A page that
fetches inventory and sales separately can render "500 minted, 620 sold" while
both halves are individually correct.

`revenue` is keyed by currency and excludes cancelled orders. Never sum across
currencies — there is no FX rate in the system.

SKU units expose the owner by **email**, not just id: an operator looking at
unit #14 of a disputed drop needs to know who holds it.

Units are paginated because a 10,000-unit edition is a legitimate drop and the
detail payload must not grow with it.

### `POST /admin/products` 🔒 platform-wide

Body as documented in [api-reference.md](../api-reference.md) — `name`,
`description`, `vertical`, `category`, `rarity`, `totalSupply`,
`purchaseLimit`, `collectionId`, `artistId`, `organizationId`, `releaseStart`,
`releaseEnd`, `status`, `isAgeSpecific`, `minimumAge`, `oddsDisclosureRef`,
`groupCode` (4-digit suffix).

→ `201 { "data": ProductResponse }`. The 12-digit `groupCode` is generated
server-side: 8 random digits + your 4-digit suffix, retried on collision.

### `PATCH /admin/products/:id` 🔒 platform-wide

Same fields minus `groupCode`. Set `collectionId` / `artistId` /
`organizationId` to `null` to detach.

### `DELETE /admin/products/:id` 🔒 platform-wide

Soft archive → `204`. Sets `archivedAt`, `isActive: false` **and**
`status: ARCHIVED` — all three, because the current schema splits soft-delete,
kill-switch and lifecycle, and leaving any unset keeps the row visible to a
query checking a different one.

---

## 4. Release approvals — `/api/v1/admin/releases`

The review workflow gating `Product.status`. **This module did not exist
before** — `packages/releases` was schema-only.

`ReleaseApproval` is **append-only per version**: resubmitting a rejected drop
creates version N+1 rather than overwriting the rejection, so the whole review
trail survives. That is what makes "why was this bounced twice" answerable six
months later.

### `GET /admin/releases`

| Param | Type | Notes |
|---|---|---|
| `status` | `PENDING` `APPROVED` `REJECTED` | |
| `complianceStatus` | `PENDING` `CLEARED` `FLAGGED` | |
| `productId`, `approverId` | uuid | |
| `latestOnly` | boolean | `true` collapses to the newest version per product — **the review queue** |
| `page` / `limit` | int | `1` / `20` (max 100) |

Ordered **pending first, then newest** — the queue an approver works through,
not a chronological archive.

```jsonc
{
  "page": 1, "limit": 20, "total": 31,
  "items": [
    {
      "id": "ra-1…", "productId": "p-991…",
      "status": "PENDING", "version": 2,
      "comment": null,
      "complianceStatus": "PENDING",
      "oddsDisclosureRef": null,
      "approverId": "u-780…",
      "approverEmail": "compliance@hitbox.demo",
      "approverName": "Kenji Watanabe",
      "checkedById": null, "checkedAt": null,
      "decidedAt": null,
      "createdAt": "2026-09-08T10:00:00.000Z",
      "updatedAt": "2026-09-08T10:00:00.000Z",
      "product": {
        "id": "p-991…", "groupCode": "482910370000",
        "name": "Neon Drift #002",
        "status": "SUBMITTED", "complianceStatus": "PENDING",
        "isAgeSpecific": false, "minimumAge": null,
        "oddsDisclosureRef": null,
        "totalSupply": 500,
        "organizationId": "org-1…", "artistId": "ar-2…"
      }
    }
  ]
}
```

Surface `isAgeSpecific`, `minimumAge` and `oddsDisclosureRef` prominently —
they are the compliance sign-off the approver is accountable for.

### `GET /admin/releases/:approvalId` — full detail

Everything above, plus:

```jsonc
{
  "history": [
    { "id": "ra-0…", "version": 1, "status": "REJECTED",
      "comment": "Odds disclosure missing.",
      "complianceStatus": "FLAGGED",
      "approverId": "u-780…", "approverEmail": "compliance@hitbox.demo",
      "decidedAt": "2026-09-05T…", "createdAt": "2026-09-04T…" }
  ],
  "canDecide": true,
  "blockedReason": null
}
```

`history` is every prior decision on the product, newest version first.
`canDecide` / `blockedReason` tell the UI whether to enable the buttons —
`blockedReason` reads *"Already decided as REJECTED. Reversing it requires the
override permission."*

### `POST /admin/releases` — open a review

```jsonc
{ "productId": "p-991…", "comment": "Ready for compliance review." }
```

→ `201`. Creates version N+1 and moves the product to `SUBMITTED` **in one
transaction** — a product sitting in `DRAFT` with an open approval against it
is a state no screen can explain.

`409 RELEASES_ALREADY_PENDING` if the product already has an undecided review;
`details` carries the open `approvalId` and `version`.

### `PATCH /admin/releases/:approvalId` — amend an undecided review

```jsonc
{
  "comment": "Chasing the odds disclosure.",
  "complianceStatus": "PENDING",
  "oddsDisclosureRef": "https://…"
}
```

The reviewer's working notes before they commit. **Refused once `decidedAt` is
set** (`409 RELEASES_ALREADY_DECIDED`) — reversing a recorded decision needs
the override path below.

### `POST /admin/releases/:approvalId/decision` — approve or reject

```jsonc
{
  "status": "APPROVED",              // APPROVED | REJECTED
  "comment": "Cleared.",             // REQUIRED when rejecting
  "complianceStatus": "CLEARED",     // defaults: CLEARED on approve, FLAGGED on reject
  "oddsDisclosureRef": "https://…"
}
```

→ `200 { "data": ReleaseApprovalDetail }`

**One transaction, three writes**, because the three are one fact: the approval
row is the evidence, `Product.complianceStatus` is what the catalog reads, and
`Product.status` is what the storefront reads. A partial apply leaves a drop
reviewers believe is approved and buyers cannot see.

| Decision | `Product.status` becomes |
|---|---|
| `APPROVED` | `APPROVED` — cleared for release. Publishing is a separate step |
| `REJECTED` | `REJECTED` |

Compliance refusals, checked here rather than left to the UI because the
approval row is what an audit reads:

| Code | Status | When |
|---|---|---|
| `RELEASES_COMPLIANCE_INCOMPLETE` | 400 | Approving an age-restricted drop with no `minimumAge` |
| `RELEASES_COMMENT_REQUIRED` | 422 | Rejecting with no `comment` |
| `RELEASES_ALREADY_DECIDED` | 409 | Deciding twice without `release-approval:override:global` |

Clearing compliance with no odds disclosure reference logs a **warning** rather
than refusing — a non-randomised drop legitimately has none.

### Reversing a decision

Requires `release-approval:override:global`, held only by
`HITBOX_SYSTEM_ADMIN`. That is what keeps "I changed my mind" separate from "I
am overruling a compliance officer". With it, `POST /decision` succeeds on an
already-decided row; without it, `409`.

---

## 5. Media — archive view

The list endpoint gained an `archived` filter.

```http
GET /api/v1/admin/media?archived=archived&page=1&limit=50
```

| `archived` | Returns |
|---|---|
| `live` | **Default.** Assets not archived |
| `archived` | Only archived assets — the recycle-bin view |
| `all` | Both |

Response shape is unchanged (see
[admin-console-api.md §11](admin-console-api.md)); archived rows carry a
non-null `archivedAt`.

**`live` is the default deliberately.** The media browser shows what is in use,
and an archived asset reappearing in it reads as "the delete did not work".

> `DELETE /admin/media/:assetId` remains a **soft** archive — the row and the
> S3 object both survive, because `ProductImage` and `ContentBundleItem`
> reference the asset. There is no un-archive endpoint yet; say the word if the
> recycle-bin view needs a restore button.

---

## 6. Roles — `/api/v1/admin/authz/roles`

### `GET /admin/authz/roles?domain=BUSINESS` — all roles **with their permissions**

Already returns the full permission list per role — no extra call needed to
render a role's capabilities.

```json
{ "data": [
  { "id": "r-1…", "name": "HITBOX_SYSTEM_ADMIN", "displayName": "HitBox System Admin",
    "entityGroup": "hitbox_seller_org", "domain": "BUSINESS",
    "isSystem": true, "isActive": true,
    "createdAt": "2026-01-04T00:00:00.000Z",
    "permissions": [
      { "key": "drop:manage:global", "description": "Full control of the drop catalog" },
      { "key": "order:manage:global", "description": null }
    ] }
] }
```

`GET /admin/authz/roles/:roleId` returns one role in the same shape.

### `POST` / `PATCH` / `DELETE /admin/authz/roles` 🔒 platform-wide

Now require `employee-role-mgmt:manage` **at `:global`**. A Brand Admin holding
it at `:organization` may still *grant* existing roles inside their
organization — they may not author the roles everyone else is granted.

```jsonc
// POST
{
  "name": "BRAND_CONTENT_EDITOR",      // SCREAMING_SNAKE_CASE, immutable
  "displayName": "Brand Content Editor",
  "entityGroup": "brand_artist",       // end_user | brand_artist | hitbox_seller_org
  "domain": "BUSINESS",                // BUSINESS | TECHNICAL
  "permissions": ["content-unlock:read:organization"]   // keys, from the catalog
}

// PATCH — displayName, entityGroup, isActive, permissions
```

Editing `permissions` **replaces** the set. `domain` is absent by design: a
role's domain is immutable, because flipping BUSINESS → TECHNICAL would
silently re-authorise everyone already holding it.

Build the picker from `GET /admin/authz/permissions?shape=grouped`. Unknown
permission strings are rejected — the catalog is the authority and nothing
outside it may invent a capability. Every permission must belong to the role's
own `domain`.

`isSystem: true` roles are seeded and must render read-only.

---

## 7. Team — `/api/v1/admin/authz/team`

### `GET /admin/authz/team`

| Param | Type | Default | Notes |
|---|---|---|---|
| `search` | string | — | Full name, email or handle, case-insensitive |
| `internalOnly` | boolean | **`true`** | HitBox internal staff only |
| `page` / `limit` | int | `1` / `20` (max 100) |

```json
{
  "page": 1, "limit": 20, "total": 23,
  "items": [
    { "userId": "3f2a9b18-1c4d…",
      "fullName": "Ana Duarte", "handle": "ana",
      "email": "ana.duarte@hitbox.demo",
      "avatarUrl": null, "isActive": true,
      "joinedAt": "2026-02-15T00:00:00.000Z",
      "roles": [
        { "assignmentId": "ra-1…", "roleId": "r-1…",
          "name": "HITBOX_SYSTEM_ADMIN", "displayName": "System Admin",
          "domain": "BUSINESS", "entityGroup": "hitbox_seller_org",
          "isSystem": true,
          "scopeType": "GLOBAL", "organizationId": null,
          "grantedAt": "2026-02-15T00:00:00.000Z" }
      ] }
  ]
}
```

### System-privilege users only

`internalOnly` defaults to **`true`**: only people holding a role whose
`entityGroup` is `hitbox_seller_org` — System Admin, Drop Manager, Content
Manager, Order Manager, Finance Admin, Support, Compliance Officer, Platform
Engineer, Full Stack Engineer. Brand Admin, Brand Employee and Artist holders
are excluded.

Pass `internalOnly=false` to include brand and artist role-holders.

**Identity is email-first.** `email` is the primary column; `userId` is still
returned because the assign/revoke routes key on it.

One row per person with roles nested — a person holding two roles appears
**once**. Their effective permissions are the union; nothing merges roles.

### Assign a role

```http
POST /api/v1/admin/authz/users/:userId/roles
```
Requires `employee-role-mgmt:assign`.

```jsonc
{
  "roleId": "r-1…",
  "scopeType": "ORGANIZATION",       // optional — defaults to the role's natural scope
  "organizationId": "org-1…"         // required for ORG scope, forbidden otherwise
}
```

→ `201 { "data": AssignmentResponse }`

| Code | Status | When |
|---|---|---|
| `ACCESS_CONTROL_ASSIGNMENT_EXISTS` | 409 | Already holds it at that scope |
| `ACCESS_CONTROL_MISSING_ORG_SCOPE` | 400 | ORG-scoped role with no `organizationId` |
| `ACCESS_CONTROL_ROLE_NOT_FOUND` | 404 | Unknown or deactivated role |

An org-scoped assigner may only grant inside their own organizations — the
engine compares the assignment's organization to the caller's reach and
returns `403` otherwise. No client-side filtering needed.

### Revoke a role

```http
DELETE /api/v1/admin/authz/users/:userId/roles/:roleId?organizationId=org-1…
```
Requires `employee-role-mgmt:delete`. → `204`.

**Revoking is a soft delete.** The assignment row survives with `revokedAt` set
so an audit can still answer "who held what in March"; revoked assignments
confer nothing. Pass `?includeRevoked=true` to
`GET /admin/authz/users/:userId/roles` to show history.

### Cache timing

Grants are cached with a short TTL and invalidated across instances on change.
The assigning caller's own next request sees the change immediately (the cache
is evicted before the response returns), but **another** session may lag by a
few seconds. Refetch the team list after a grant rather than asserting
instantly.

---

## 8. New error codes

| Code | Status | Module |
|---|---|---|
| `MARKETS_NOT_FOUND` | 404 | markets |
| `MARKETS_CODE_TAKEN` | 409 | markets |
| `MARKETS_COUNTRY_TAKEN` | 409 | markets |
| `MARKETS_IN_USE` | 409 | markets |
| `MARKETS_DEFAULT_REQUIRED` | 400 | markets |
| `ORDERS_NOT_FOUND` | 404 | orders |
| `ORDERS_INVALID_TRANSITION` | 400 / 409 | orders |
| `ORDERS_STATUS_NOT_SETTABLE` | 400 | orders |
| `RELEASES_NOT_FOUND` | 404 | releases |
| `RELEASES_ALREADY_DECIDED` | 409 | releases |
| `RELEASES_ALREADY_PENDING` | 409 | releases |
| `RELEASES_COMMENT_REQUIRED` | 422 | releases |
| `RELEASES_COMPLIANCE_INCOMPLETE` | 400 | releases |
| `AUTHZ_FORBIDDEN` | 403 | any `globalOnly` route, when the grant is org-scoped |

---

## 9. Integration checklist

- [ ] Expect `403 AUTHZ_FORBIDDEN` on every 🔒 route unless the caller's grant is `:global`
- [ ] Move product create/update/delete calls from `/api/v1/products` to `/api/v1/admin/products`
- [ ] Drive the order status buttons from `allowedTransitions`, not a hardcoded list
- [ ] Require a `reason` in the cancel dialog — the API rejects a cancellation without one
- [ ] Treat a repeated status change as success (200), not an error
- [ ] Handle `409` on status change as "someone else changed it — reload"
- [ ] Send the **full** `countryCodes` list when editing a market; it replaces, not merges
- [ ] Do not offer "clear default" on a market — promote another instead
- [ ] Show `ORDERS_INVALID_TRANSITION.details.allowed` when a transition is refused
- [ ] Render `skuUnits[].allocation` distinctly — `HELD` is not `ALLOCATED`
- [ ] Paginate product SKU units (`skuPage`/`skuLimit`); editions can be large
- [ ] Never sum `performance.revenue` across currencies
- [ ] Require a comment in the reject dialog — the API rejects without one
- [ ] Use `canDecide`/`blockedReason` to enable the approve/reject buttons
- [ ] Default the media browser to `archived=live`
- [ ] Show `isSystem: true` roles as read-only
- [ ] Default the Team list to `internalOnly=true`
- [ ] Refetch the team after assigning a role; grants are cached briefly
