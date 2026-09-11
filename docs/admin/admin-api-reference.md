# HitBox Admin API — Frontend Reference

> Everything a frontend needs to build the admin surface: endpoints, query
> parameters, response shapes, per-role differences, and error handling.
>
> Written to be handed to a frontend engineer directly. Response examples are
> the **real** shapes this backend emits, not illustrations.
>
> Related: [authorization architecture](../authorization/authorization-architecture.md)
> (how permissions work), [database architecture](../database-architecture.md).

---

## 1. The one thing to understand first

**There are no per-role endpoints.** There is no `/order-manager/*`, no
`/finance-admin/*`. Every admin calls the *same* URLs, and the backend decides
what comes back from their permissions.

That has one consequence the UI must handle correctly:

> **A section the caller cannot see is OMITTED from the JSON — not empty, not
> zero, not null.**

```jsonc
// HITBOX_ORDER_MANAGER — no `finance` key at all
{ "period": {...}, "summary": {...}, "orders": {...}, "operations": {...} }

// HITBOX_SYSTEM_ADMIN — same request, same URL
{ "period": {...}, "summary": {...}, "orders": {...}, "finance": {...}, ... }
```

So render with `if ('finance' in response)`, never `if (response.finance?.total > 0)`.
`{ "revenue": 0 }` would mean "no revenue this month"; a missing key means
"you are not allowed to see revenue". Those must look different in the UI.

**Build the navigation from `GET /api/v1/authz/me`,** not from a hardcoded
role→menu map. Hardcoding role names in the frontend re-introduces exactly the
coupling the backend removed.

---

## 2. Conventions

| | |
|---|---|
| Base URL | `/api/v1` |
| Auth | `Authorization: Bearer <Clerk session JWT>` on every request |
| Content type | `application/json` |
| Dates | ISO 8601 UTC (`2026-09-11T13:45:00.000Z`) |
| Money | **Always** an object keyed by currency: `{ "USD": "84210.00" }` |
| Pagination | `?page=1&limit=20` (max `limit` 100) |

### Money is never a number

```jsonc
"grossRevenue": { "USD": "84210.00", "INR": "1980000.00", "GBP": "9120.00" }
```

Strings, because they come from Postgres `numeric` and a JavaScript float would
round a large INR figure. **Never sum across currencies in the UI** — the
backend deliberately doesn't, because there is no FX rate anywhere in the
system. Show one figure per currency, or let the user pick a currency.

An empty object `{}` means no money in that window — that is different from
the key being absent, which means no permission.

### Error envelope

Every non-2xx response:

```json
{ "error": { "code": "AUTHZ_FORBIDDEN", "message": "...", "details": null } }
```

| Status | Code | Meaning |
|---|---|---|
| 401 | `AUTH_UNAUTHENTICATED` | No / invalid session token |
| 401 | `AUTH_EMAIL_UNVERIFIED` | Session valid, email not verified |
| 403 | `AUTHZ_FORBIDDEN` | Caller lacks the capability |
| 403 | `SCOPE_MISMATCH` | `organizationId` outside the caller's scope |
| 404 | `NOT_FOUND` | Missing — **or** out of scope (deliberately identical) |
| 409 | `AUTHZ_ROLE_IN_USE` | Role still assigned; revoke assignments first |
| 422 | `VALIDATION_ERROR` | Zod failure; `details` carries field errors |
| 422 | `INVALID_RANGE` | `from` is not before `to` |
| 503 | `STORAGE_UNAVAILABLE` | Media storage not configured on this deploy |

---

## 3. `GET /api/v1/authz/me` — start here

The caller's own effective permissions. Call it once after login and drive the
whole menu from it.

```http
GET /api/v1/authz/me
```

```json
{
  "data": {
    "userId": "3f2a9b1c-...",
    "permissions": [
      "audit-log:read:global",
      "buyer-profile:manage:global",
      "drop:manage:global",
      "order:manage:global",
      "payment-royalty:manage:global"
    ],
    "roles": [
      { "roleId": "r-1...", "roleName": "HITBOX_SYSTEM_ADMIN", "organizationId": null }
    ]
  }
}
```

Permission keys are `resource:action:scope`. To decide whether to show the
revenue tab: `permissions.some(p => p.startsWith('payment-royalty:'))` — never
`roles.includes('HITBOX_FINANCE_ADMIN')`.

`organizationId` is non-null for brand-scoped roles; a user can hold several
roles at different scopes at once.

---

## 4. Dashboard

### `GET /api/v1/admin/dashboard`

The main aggregate. One call, many sections.

| Param | Type | Notes |
|---|---|---|
| `period` | `week` \| `month` \| `year` \| `custom` | Default `month` |
| `from`, `to` | ISO date | Required when `period=custom`. Half-open: `>= from`, `< to` |
| `organizationId` | uuid | **Filter only** — narrows within the caller's scope; 403 outside it |
| `marketId` | uuid | Filter only, same rule |

#### Which permission produces which section

| Section | Requires | Notes |
|---|---|---|
| `summary` | — | Projection of the sections below; only contains cards you can see |
| `users` | `buyer-profile:read` and/or `employee-role-mgmt:read` | Two halves: buyer counts vs. `newAdmins`/`totalAdmins` |
| `orders` | `order:read` | |
| `finance` | `payment-royalty:read` | |
| `payments` | `payment-royalty:read` | |
| `refunds` | `order:read` (counts) | `amount` added only with `payment-royalty:read` |
| `markets` | `reports-dashboards:read` + order or buyer access | Re-slice of data you can already see |
| `products` | `drop:read` | Includes an inventory preview (10 products) |
| `content` | `content-unlock:read` | |
| `artists`, `organizations` | `brand-artist-record:read` | |
| `operations` | `order:read` | `paymentsNeedingReview` added only with `payment-royalty:read` |
| `provenance` | `nfc-tag-claim:read` or `collectible-instance:read` | |
| `paymentGatewayConfig` | `payment-royalty:read` | `credentialsRef` is **never** returned |
| `activity` | `audit-log:read` | Latest 20; paginate via `/activity` |

#### Full response — `HITBOX_SYSTEM_ADMIN`

Returns 16 keys: `period`, `summary`, `users`, `orders`, `finance`, `payments`,
`refunds`, `markets`, `products`, `content`, `artists`, `organizations`,
`operations`, `provenance`, `paymentGatewayConfig`, `activity`.

```jsonc
{
  "period": { "type": "month", "from": "2026-08-12T00:00:00.000Z", "to": "2026-09-12T00:00:00.000Z" },

  "summary": {
    "totalUsers": 48213, "newUsers": 1284, "adminUsers": 23,
    "totalOrders": 18420, "newOrders": 640, "totalProducts": 340,
    "grossRevenue": { "USD": "84210.00", "INR": "1980000.00" },
    "netRevenue":   { "USD": "71040.50", "INR": "1702000.00" },
    "refunds":      { "USD": "3200.00" },
    "profit":       { "USD": "22110.00" }
  },

  "users": {
    "total": 48213, "new": 1284, "active": 46102, "inactive": 2111,
    "newAdmins": 23, "totalAdmins": 142,
    "growthPercentage": 12.4,          // null when the previous window was empty
    "trend":    [{ "date": "2026-08-12", "users": 38 }],
    "byMarket": [{ "marketId": "5a9e...", "code": "IN", "name": "India", "users": 21032, "newUsers": 640 }]
  },

  "orders": {
    "total": 18420, "new": 640, "growthPercentage": 8.1,
    "pendingPayment": 84, "paid": 120, "processing": 210, "shipped": 340,
    "delivered": 17400, "cancelled": 220, "refunded": 166,
    "trend":    [{ "date": "2026-08-12", "orders": 19 }],
    "byMarket": [{ "marketId": "5a9e...", "orders": 8200, "newOrders": 310 }]
  },

  "finance": {
    "grossRevenue":     { "USD": "84210.00" },   // Order.amount
    "collectedRevenue": { "USD": "81900.00" },   // SUCCEEDED payments
    "refundedAmount":   { "USD": "3200.00" },    // PROCESSED refunds only
    "netRevenue":       { "USD": "78700.00" },   // collected − refunded
    "costOfGoods":      { "USD": "34200.00" },
    "gatewayFees":      { "USD": "2380.00" },
    "royalties":        { "USD": "19010.00" },
    "profit":           { "USD": "23110.00" }    // net − COGS − fees − royalties
  },

  "payments": {
    "successful": 612, "pending": 14, "initiated": 3, "failed": 9, "needsReview": 5,
    "amount": { "USD": "81900.00" }
  },

  "refunds": {
    "requested": 210, "awaitingReturn": 12, "approved": 30,
    "processed": 166, "rejected": 14,
    "amount": { "USD": "3200.00" }
  },

  "markets": [
    { "marketId": "5a9e...", "code": "IN", "name": "India", "currency": "INR",
      "users": 21032, "newUsers": 640, "orders": 8200, "newOrders": 310,
      "revenue": { "INR": "1980000.00" } }
  ],

  "products": {
    "total": 340, "new": 12,
    "draft": 12, "submitted": 4, "inReview": 3, "approved": 6, "rejected": 2,
    "published": 40, "active": 210, "ended": 55, "archived": 8,
    "inventory": [
      { "productId": "p-991...", "name": "Neon Drift #002", "totalSupply": 500,
        "reserved": 12, "committed": 8, "claimed": 310, "sold": 330, "available": 170 }
    ]
  },

  "content":  { "totalBundles": 88, "activeBundles": 74, "newBundles": 6,
                "unlocksThisPeriod": 1420, "avgAccessCount": 3.2 },
  "artists":  { "total": 512, "active": 470, "new": 8, "public": 390 },
  "organizations": { "total": 42, "byType": { "BRAND": 38, "ARTIST_INDIVIDUAL": 3, "HITBOX": 1 } },

  "operations": {
    "ordersPendingPayment": 84, "ordersProcessing": 210, "ordersAwaitingShipment": 96,
    "ordersShipped": 340, "ordersDelivered": 17400,
    "refundsAwaitingAction": 42, "paymentsNeedingReview": 5
  },

  "provenance": {
    "claimed":   { "UNCLAIMED": 4200, "CLAIMED": 12800, "FLAGGED": 6 },
    "lifecycle": { "BOUND": 4200, "ACTIVE": 12800, "DISPUTED": 3 },
    "resaleBlocked": 14, "tampered": 3,
    "cases": { "OPEN": 12, "INVESTIGATING": 4, "RESOLVED": 210 }
  },

  "paymentGatewayConfig": [
    { "id": "gc-1...", "scope": "PLATFORM", "gateway": "STRIPE", "isDefault": true,
      "status": "ACTIVE", "organizationId": null,
      "createdAt": "...", "updatedAt": "..." }
  ],

  "activity": [
    { "eventId": "e91a...", "occurredAt": "2026-09-10T14:02:00.000Z",
      "type": "order.refund.approved", "actorId": "u-772...",
      "actorRoleSnapshot": "HITBOX_FINANCE_ADMIN",
      "resourceType": "RefundRequest", "resourceId": "r-441...",
      "actionResult": "SUCCESS", "severity": "INFO" }
  ]
}
```

> `activity[].actorRoleSnapshot` is the role the actor held **at the time**.
> Render that, not their current roles — a since-revoked Finance Admin's past
> approval must still read "Finance Admin approved this".

#### Same request — `HITBOX_ORDER_MANAGER`

Returns 8 keys: `period`, `summary`, `users`, `orders`, `refunds`, `markets`,
`operations`, `provenance`.

```jsonc
{
  "period": { ... },
  "summary": { "totalUsers": 48213, "newUsers": 1284, "totalOrders": 18420, "newOrders": 640 },
  "orders": { ...same shape as above... },
  "refunds": { "requested": 210, "awaitingReturn": 12, "approved": 30,
               "processed": 166, "rejected": 14 },          // no "amount"
  "operations": { "ordersPendingPayment": 84, "ordersProcessing": 210,
                  "ordersAwaitingShipment": 96, "ordersShipped": 340,
                  "ordersDelivered": 17400, "refundsAwaitingAction": 42 }
                                                            // no "paymentsNeedingReview"
}
```

Absent entirely: `finance`, `payments`, `paymentGatewayConfig`, `products`,
`content`, `artists`, `organizations`, `activity`. The summary carries no
revenue or profit cards. **This is the canonical example** — an Order Manager
sees "166 refunds processed" but never the refunded amount.

#### Same request — `HITBOX_FINANCE_ADMIN`

Returns 9 keys: `period`, `summary`, `orders`, `finance`, `payments`,
`refunds`, `markets`, `operations`, `paymentGatewayConfig`.

Summary carries `grossRevenue`, `netRevenue`, `profit`, `refunds`,
`totalOrders`, `newOrders` — but no `totalUsers` (no `buyer-profile` grant) and
no `totalProducts` (no `drop` grant). Absent: `users`, `products`, `content`,
`artists`, `provenance`, `activity`.

#### Technical roles

`HITBOX_PLATFORM_ENGINEER` and `HITBOX_FULL_STACK_ENGINEER` hold no
BUSINESS-domain permission, so they receive `{ "period": ..., "summary": {} }`
and nothing else. They are not dashboard users — build them a separate ops
console if one is needed.

### Sub-endpoints

Same auth and scope rules; each returns **one** section, paginated. Because
there is no surrounding payload, a caller without the permission gets **403**
here rather than an omitted key.

```http
GET /api/v1/admin/dashboard/users?period=month
GET /api/v1/admin/dashboard/orders?period=month&status=SHIPPED&marketId=...&page=1&limit=50
GET /api/v1/admin/dashboard/finance?period=year
GET /api/v1/admin/dashboard/markets?period=month
GET /api/v1/admin/dashboard/products?status=ACTIVE&page=1&limit=50
GET /api/v1/admin/dashboard/release-approvals?status=PENDING
GET /api/v1/admin/dashboard/provenance?caseType=CLONED&status=OPEN
GET /api/v1/admin/dashboard/supply?vendorId=...
GET /api/v1/admin/dashboard/resale?status=ACTIVE
GET /api/v1/admin/dashboard/activity?severity=CRITICAL&page=1&limit=50
GET /api/v1/admin/dashboard/demand-signals
```

| Endpoint | Requires | Envelope |
|---|---|---|
| `/users` | `buyer-profile:read` | `{ "data": {...} }` |
| `/orders` | `order:read` | `{ page, limit, total, items[] }` |
| `/finance` | `payment-royalty:read` | `{ "data": {...} }` |
| `/markets` | `reports-dashboards:read` | `{ "data": [...] }` |
| `/products` | `drop:read` | `{ page, limit, total, items[] }` |
| `/release-approvals` | `release-approval:read` | `{ page, limit, total, items[] }` |
| `/provenance` | `nfc-tag-claim:read` | `{ page, limit, total, summary, items[] }` |
| `/supply` | `drop:read` | `{ page, limit, total, items[], activeVendors }` |
| `/resale` | `order:read` | `{ page, limit, total, counts, items[] }` |
| `/activity` | `audit-log:read` | `{ page, limit, total, items[] }` |
| `/demand-signals` | `drop:read` | `{ "data": [...] }` |

#### `/orders` item — fields vary by permission

```jsonc
{
  "id": "o-1...", "status": "SHIPPED", "quantity": 1,
  "marketId": "5a9e...", "organizationId": "org-1...",
  "productId": "p-991...", "skuId": "sku-402...",
  "placedAt": "...", "shippedAt": "...", "deliveredAt": null,

  "amount": "129.00", "currency": "USD",   // only with payment-royalty:read
  "buyerId": "3f2a9b1c-..."                // only with buyer-profile:read;
                                           // truncated to "3f2a9b1c…" unless FULL visibility
}
```

#### `/release-approvals` item

```json
{
  "id": "ra-1...", "productId": "p-991...", "status": "PENDING", "version": 2,
  "comment": null, "complianceStatus": "PENDING", "oddsDisclosureRef": null,
  "decidedAt": null, "createdAt": "2026-09-08T10:00:00.000Z",
  "product": { "name": "Neon Drift #002", "isAgeSpecific": false, "minimumAge": null, "status": "SUBMITTED" }
}
```

Surface `isAgeSpecific`, `minimumAge` and `oddsDisclosureRef` prominently —
they are the compliance sign-off the approver is accountable for.

#### `/provenance` item

```json
{
  "id": "sc-118...", "caseType": "CLONED", "status": "INVESTIGATING",
  "tagId": "04A2FE...", "skuId": "sku-402...",
  "reporterId": "u-556f21…", "description": "...", "resolvedAt": null,
  "createdAt": "2026-09-09T08:30:00.000Z",
  "sku": { "tagLifecycleState": "DISPUTED", "tamperStatus": "counter_regression", "claimedStatus": "FLAGGED" }
}
```

---

## 5. Authorization administration

One generic set of endpoints. There is no per-role admin screen — you build
*one* role editor and *one* assignment screen.

| Method | Path | Requires |
|---|---|---|
| `GET` | `/api/v1/admin/authz/permissions` | `employee-role-mgmt:read` |
| `GET` | `/api/v1/admin/authz/roles` | `employee-role-mgmt:read` |
| `GET` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:read` |
| `POST` | `/api/v1/admin/authz/roles` | `employee-role-mgmt:manage` |
| `PATCH` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:manage` |
| `DELETE` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:manage` |
| `GET` | `/api/v1/admin/authz/users/:userId/roles` | `employee-role-mgmt:read` |
| `POST` | `/api/v1/admin/authz/users/:userId/roles` | `employee-role-mgmt:assign` |
| `DELETE` | `/api/v1/admin/authz/users/:userId/roles/:roleId` | `employee-role-mgmt:delete` |

### `GET /admin/authz/permissions?shape=grouped` (default)

Render this as a checkbox tree. **Never show raw permission strings as the
primary UI** and never let an admin type one — the backend rejects anything
not in this catalog.

```json
{
  "data": [
    {
      "resource": "ORDER", "group": "Orders", "domain": "BUSINESS",
      "permissions": [
        { "key": "order:read:own",     "actionLabel": "Read",   "scopeLabel": "Own records",
          "description": "View your own orders." },
        { "key": "order:refund:global","actionLabel": "Refund", "scopeLabel": "Platform-wide",
          "description": "Issue a refund on any order." }
      ]
    }
  ],
  "meta": { "shape": "grouped" }
}
```

Add `?domain=TECHNICAL` to filter. Use `?shape=flat` for a plain list.

### `POST /admin/authz/roles`

```json
{
  "name": "BRAND_CONTENT_EDITOR",
  "displayName": "Brand Content Editor",
  "entityGroup": "brand_artist",
  "domain": "BUSINESS",
  "permissions": ["content-unlock:manage:organization", "drop:manage:organization"]
}
```

`name` must be `SCREAMING_SNAKE_CASE`. **Every permission must be same-domain
as the role** — mixing BUSINESS and TECHNICAL returns 400
`AUTHZ_DOMAIN_VIOLATION` with the offending keys in `details`. The UI should
filter the permission tree to the selected domain so this is unreachable.

Roles returned with `"isSystem": true` are the 12 seeded platform roles: their
permissions cannot be edited and they cannot be deleted (403
`AUTHZ_ROLE_IMMUTABLE`). Deactivating one via `PATCH { "isActive": false }` is
allowed. Render them read-only.

### `POST /admin/authz/users/:userId/roles`

```json
{ "roleId": "r-1...", "scopeType": "ORGANIZATION", "organizationId": "org-1..." }
```

`scopeType` is optional — it defaults to the role's natural scope
(`brand_artist` → ORGANIZATION, `end_user` → OWN, otherwise GLOBAL).
`organizationId` is required for ORGANIZATION and rejected for the others.

**Users hold multiple roles.** The UI must support a list, not a single-select
dropdown. Revoking is a soft delete — the assignment row survives for audit.

---

## 6. Media

Base: `/api/v1/admin/media`. All routes require `assets-documents-upload` at a
scope covering the asset's owner.

> Returns **503 `STORAGE_UNAVAILABLE`** on a deployment with no bucket
> configured (`MEDIA_S3_BUCKET` unset). Handle that before building against it.

### Upload is a three-step flow

File bytes never pass through the API.

```
1. POST /admin/media/upload-url   → { assetId, uploadUrl, storageRef }
2. PUT  <uploadUrl>               → the raw file, straight to S3 (5-min expiry)
3. the scanner flips the asset to CLEAN asynchronously
```

**Between steps 2 and 3 the asset is not servable.** `GET /:assetId/url`
returns 404 until the scan completes. The UI should show a "processing" state
after upload and poll `GET /admin/media?ownerId=...` for
`virusScanStatus: "CLEAN"`.

#### `POST /admin/media/upload-url`

```json
{
  "assetType": "DROP_IMAGE",
  "fileName": "hero.jpg",
  "mimeType": "image/jpeg",
  "ownerType": "product",
  "ownerId": "p-991a2b3c-...",
  "sizeBytes": 482113
}
```

```json
{
  "assetId": "a-771f...",
  "uploadUrl": "https://hitbox-media-prod.s3.amazonaws.com/drop-images/products/p-991.../a-771....jpg?X-Amz-...",
  "expiresIn": 300,
  "storageRef": "drop-images/products/p-991.../a-771....jpg",
  "bucket": "hitbox-media-prod"
}
```

Then `PUT` the bytes to `uploadUrl` with the **same** `Content-Type` you
declared — the signature is bound to it.

| `assetType` | Valid `ownerType` | MIME types | Max size |
|---|---|---|---|
| `DROP_IMAGE` | `product` | jpeg, png, webp, gif | 15 MB |
| `PROFILE_IMAGE` | `user`, `artist` | jpeg, png, webp, gif | 15 MB |
| `EXCLUSIVE_CONTENT` | `product`, `collection` | images, mp4, mpeg, pdf | 500 MB |
| `LEGAL_DOCUMENT` | `organization` | pdf | 25 MB |
| `SUPPLY_SPREADSHEET` | `vendor` | csv, xls, xlsx | 25 MB |
| `OTHER` | any | any | 25 MB |

Errors: `UNSUPPORTED_MIME_TYPE`, `FILE_TOO_LARGE`, `INVALID_OWNER` (wrong owner
type for that asset type), `SCOPE_MISMATCH` (owner outside your organization) —
all returned *before* any URL is issued.

#### `GET /admin/media`

Params: `assetType`, `ownerType`, `ownerId`, `virusScanStatus`, `page`, `limit`.

```json
{
  "page": 1, "limit": 20, "total": 3120,
  "byType": { "DROP_IMAGE": 1840, "PROFILE_IMAGE": 1020, "EXCLUSIVE_CONTENT": 210 },
  "byScanStatus": { "CLEAN": 3080, "PENDING": 25, "INFECTED": 1, "SKIPPED": 14 },
  "items": [
    { "assetId": "a-771f...", "assetType": "DROP_IMAGE", "fileName": "hero.jpg",
      "storageRef": "drop-images/products/p-991.../a-771....jpg",
      "mimeType": "image/jpeg", "sizeBytes": 482113, "virusScanStatus": "CLEAN",
      "productId": "p-991...", "collectionId": null, "organizationId": "org-1...",
      "artistId": null, "uploadedById": "u-220...",
      "archivedAt": null, "createdAt": "2026-09-05T12:00:00.000Z" }
  ]
}
```

`storageRef` is an S3 **key**, not a URL. Do not build a URL from it.

#### `GET /admin/media/:assetId/url`

```json
{ "url": "https://hitbox-media-prod.s3.amazonaws.com/...", "expiresIn": 60 }
```

60 seconds. Fetch it when you render, do not cache it. **404 covers four
cases identically** — not found, not `CLEAN`, archived, or out of scope — so
that asset ids from other organizations cannot be probed.

#### `DELETE /admin/media/:assetId`

Soft archive. The row and the S3 object both survive, because `ProductImage`
and `ContentBundleItem` reference the asset.

```json
{ "assetId": "a-771f...", "archivedAt": "2026-09-11T09:00:00.000Z" }
```

---

## 7. What each role sees — quick reference

Built from the **real seeded catalog**, verified against the running service.

| Role | Dashboard sections |
|---|---|
| `HITBOX_SYSTEM_ADMIN` | everything (16 keys) |
| `HITBOX_DROP_MANAGER` | summary, products, release-approvals, provenance, markets, media, orders (counts only) |
| `HITBOX_CONTENT_MANAGER` | summary, content, products (read), media |
| `HITBOX_ORDER_MANAGER` | summary, users, orders, refunds (counts), markets, operations, provenance |
| `HITBOX_FINANCE_ADMIN` | summary, orders, finance, payments, refunds (+amounts), markets, operations, paymentGatewayConfig |
| `HITBOX_SUPPORT` | provenance (case queue), orders (masked) |
| `BRAND_ADMIN` | summary, orders, finance*, products, content, artists, media — **all scoped to their organization** |
| `BRAND_EMPLOYEE` | summary, orders, products, artists (read), media — org-scoped, **no finance** |
| `ARTIST` | own records only (`:own` scope throughout) |
| `HITBOX_PLATFORM_ENGINEER` | **none** — TECHNICAL domain |
| `HITBOX_FULL_STACK_ENGINEER` | **none** — TECHNICAL domain |

\* Brand Admin's finance is `payment-royalty:read:organization` — their own
royalties, never platform margin.

> `HITBOX_DB_ADMIN` does not exist in this system. Database administration is a
> cloud/IAM concern, outside application authorization.

---

## 8. Frontend checklist

- [ ] Drive navigation from `/authz/me` permissions, never from role names
- [ ] Treat a **missing key** as "not permitted" and an **empty value** as "no data" — show them differently
- [ ] Render money per currency; never add `USD + INR`
- [ ] Handle `growthPercentage: null` (no baseline) distinctly from `0`
- [ ] Support multiple roles per user in the assignment UI
- [ ] Render the permission tree from `/admin/authz/permissions`; never free-text a permission
- [ ] Filter the permission tree by the role's `domain` when editing a role
- [ ] Show `isSystem: true` roles as read-only
- [ ] Show a "processing" state for media between upload and `CLEAN`
- [ ] Re-fetch media signed URLs on render (60s expiry)
- [ ] Use `actorRoleSnapshot` in the activity feed, not the actor's current roles

---

## 9. Known gaps

Worth knowing before you build against them:

1. **Demo data is seeded** (`pnpm db:seed:demo`) — all 53 tables, including 50
   users, 12 products across all nine `DropStatus` states, 100 SKUs, 60 orders
   in three currencies, refunds, support cases and audit events. The numbers in
   the examples above are illustrative, but the *shapes* are real and the
   endpoints return live figures. Re-running the seed is destructive and
   replaces all business data; it never touches the roles/permissions catalog.

   **Signing in needs a Clerk account.** The seeded admin
   (`admin@hitbox.demo`) carries a placeholder `clerkId`, because this backend
   stores no passwords — Clerk owns identity and the `User` row is only a local
   projection. Create the account in Clerk, then
   `pnpm db:link-admin -- <clerkUserId>` to attach it.
2. **Media S3 is unverified.** The registry logic, permission checks, key
   convention and scan gating are tested; the two presign calls have never run
   against a live bucket. Expect to smoke-test step 2 of the upload flow first.
3. **The scan-result callback is not mounted** until an authentication
   mechanism for the scanner is configured, so assets stay `PENDING` on a fresh
   deploy. Flip them manually while testing.
4. **`notifications` and `platformConfig` sections are not implemented.**
   `PLATFORM_CONFIG` is a TECHNICAL-domain resource in this system, and the
   dashboard is BUSINESS-domain — mixing them in one payload would break the
   domain boundary. They belong to a separate ops console.
5. **`supply` is gated on `drop:read`**, not on `OPS_DASHBOARD_INFRA` as the
   original matrix proposed, for the same domain reason.
6. **No CSV/export endpoints yet.** `reports-dashboards:export:global` exists in
   the catalog but nothing consumes it.
