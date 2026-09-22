# Admin Console — Screen-by-Screen API Guide

> **For the frontend engineer integrating the admin console designs.** One
> section per screen: which endpoint backs it, what to send, what comes back,
> and what will bite you.
>
> This is the *screen-oriented* companion to
> [admin-api-reference.md](admin-api-reference.md), which documents the same
> endpoints grouped by module. Authentication and session handling live in
> [authentication.md](authentication.md) — read that first.
>
> **Everything that writes** — market CRUD, order status changes, product
> CRUD, release approvals, role editing, role assignment — is in
> [admin-write-apis.md](admin-write-apis.md). This document covers the
> read/reporting surface.
>
> **Product upload** — creating a drop, the accepted request formats, market
> pricing, the image gallery, and the brand/artist pickers — is in
> [product-upload-api.md](product-upload-api.md).
> **Serialized units and NFC tags** — minting, tag manifests, and the per-role
> field visibility matrix — are in [sku-api.md](sku-api.md).

---

## 0. Before you build anything

### The navigation is not a constant

The sidebar in the designs shows 16 items. **No user sees all 16.** The footer
of the design says it outright: *"Navigation is built from your effective
permissions, not your role name."*

Build the sidebar from `GET /api/v1/authz/me`, never from a hardcoded array
and never from a role name. A Finance Admin has no Products entry; an Order
Manager has no Finance entry. Hardcoding the list produces a menu of links
that 403.

```ts
const { permissions } = await api.get('/authz/me');
const canSee = (cap: string) => permissions.includes(cap);
```

| Sidebar item | Show when the caller holds |
|---|---|
| Dashboard | *(always — the payload itself is filtered)* |
| Markets | `reports-dashboards:read` |
| Orders | `order:read` |
| Finance | `payment-royalty:read` |
| Resale | `order:read` |
| Buyers | `buyer-profile:read` |
| Products | `drop:read` |
| Supply | `drop:read` |
| Demand signals | `drop:read` |
| Content | `content-unlock:read` |
| Media | `assets-documents-upload:read` |
| Provenance | `nfc-tag-claim:read` or `collectible-instance:read` |
| Audit log | `audit-log:read` |
| Publish drop | `release-approval:manage` — see 14 for what is still missing |
| Roles | `employee-role-mgmt:read` |
| Team | `employee-role-mgmt:read` |

Permission strings returned by `/authz/me` carry a scope suffix
(`order:read:global`, `order:read:organization`). Match on the `resource:action`
prefix unless you specifically care about reach.

### Two envelope shapes, and they are not interchangeable

```jsonc
{ "data": { … } }                                  // single object / aggregate
{ "page": 1, "limit": 20, "total": 340, "items": [ … ] }  // paginated list
```

Paginated endpoints return `page`/`limit`/`total`/`items` at the **top level**,
not nested under `data`. Check the table in each section below.

### Money is never a number

Every monetary value is a **decimal string**, keyed by currency:

```json
{ "grossRevenue": { "USD": "84210.00", "INR": "1980000.00", "GBP": "9120.00" } }
```

There is no FX rate anywhere in the system, so **never sum across currencies**.
The Finance screen's three side-by-side cards exist precisely because a single
"total revenue" figure would be a fabrication. Render one column per currency
key present, and treat an absent key as "no activity in that currency" — not
zero.

### An absent key is not an empty value

A section the caller cannot see is **omitted from the JSON entirely**. It is
never `{}`, `[]` or `0`. This is deliberate: `0` reads as "no data this period",
which is a different and misleading claim than "you may not see this".

```ts
// Correct
if ('finance' in response) renderFinanceCard(response.finance);

// Wrong — shows an empty card to someone who should see no card at all
renderFinanceCard(response.finance ?? { grossRevenue: {} });
```

On the **aggregate** endpoint (`GET /admin/dashboard`) a forbidden section is
omitted. On a **sub-endpoint** (`GET /admin/dashboard/orders`) the same caller
gets a `403` instead, because there is no surrounding payload to omit from.

### Period selector

Screens with a `7 days / 30 days / 12 months` toggle map to:

| Toggle | Query |
|---|---|
| 7 days | `?period=week` |
| 30 days | `?period=month` *(default)* |
| 12 months | `?period=year` |
| *(custom)* | `?period=custom&from=2026-08-01&to=2026-09-01` |

Ranges are half-open: `>= from`, `< to`. `period=custom` without both bounds is
a `422 INVALID_RANGE`.

### Error envelope

```json
{ "error": { "code": "AUTHZ_FORBIDDEN", "message": "…", "details": null } }
```

| Status | Code | What the UI should do |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Session expired — re-auth (see [authentication.md](authentication.md)) |
| 403 | `AUTHZ_FORBIDDEN` | Hide the screen; this should not happen if the sidebar was built from `/authz/me` |
| 403 | `SCOPE_MISMATCH` | The `organizationId` filter is outside the caller's reach |
| 404 | — | Also returned for out-of-scope records, deliberately (see 11) |
| 422 | `VALIDATION_ERROR` | Field-level problems in `details` |
| 503 | `STORAGE_UNAVAILABLE` | Media only — no bucket configured on this deploy |

---

## 1. Dashboard

**Design: PDF pages 1, 17, 18** (one screen, split across three pages — top,
middle, bottom).

```http
GET /api/v1/admin/dashboard?period=month
```

**One call renders the entire screen.** Do not fan out to the sub-endpoints for
the dashboard — they exist for the dedicated screens in 2–13.

| Param | Type | Notes |
|---|---|---|
| `period` | `week` \| `month` \| `year` \| `custom` | Default `month` |
| `from`, `to` | ISO date | Required with `period=custom` |
| `organizationId` | uuid | Filter only — narrows *within* your scope, 403 outside it |
| `marketId` | uuid | Filter only, same rule |

### Design element → response key

| What you see (page) | Key | Notes |
|---|---|---|
| Buyers / Orders / Gross revenue / Profit KPI cards (p1) | `summary` | `+12.4%` chip is `users.growthPercentage` |
| KPI card sparklines (p1) | `users.trend`, `orders.trend` | `[{ date, users }]` / `[{ date, orders }]` |
| "Orders placed" chart (p1) | `orders.trend` | |
| "New buyers" chart (p1) | `users.trend` | |
| Finance panel (p1) | `finance` | 7 rows + per-currency profit |
| Operations queue (p1) | `operations` | |
| "5 payments need manual review" (p1) | `operations.paymentsNeedingReview` | Only with `payment-royalty:read` |
| Order pipeline bar (p1) | `orders` | `delivered`, `shipped`, `processing`, `paid`, `pendingPayment`, `cancelled`, `refunded` |
| Refunds strip (p17) | `refunds` | `amount` only with `payment-royalty:read` |
| Markets bar chart (p17) | `markets[]` | |
| Drops status pills (p17) | `products` | `draft`, `submitted`, `inReview`, `approved`, `rejected`, `published`, `active`, `ended`, `archived` |
| Inventory preview table (p17) | `products.inventory` | **Capped at 10.** Full list is 7 |
| Provenance panel (p17) | `provenance` | |
| Catalogue panel (p17) | `content`, `artists`, `organizations` | |
| Payment gateways (p17/18) | `paymentGatewayConfig[]` | |
| Recent activity (p18) | `activity[]` | **Latest 20.** "Full audit log →" goes to 12 |

### Response

```jsonc
{
  "period": { "type": "month", "from": "2026-08-12T00:00:00.000Z", "to": "2026-09-12T00:00:00.000Z" },

  "summary": {
    "totalUsers": 48213, "newUsers": 1284, "adminUsers": 23,
    "totalOrders": 18420, "newOrders": 640, "totalProducts": 340,
    "grossRevenue": { "USD": "84210.00", "INR": "1980000.00" },
    "netRevenue":   { "USD": "78700.00" },
    "refunds":      { "USD": "3200.00" },
    "profit":       { "USD": "23110.00" }
  },

  "users": {
    "total": 48213, "new": 1284, "active": 46092, "inactive": 2121,
    "newAdmins": 23, "totalAdmins": 142,
    "growthPercentage": 12.4,
    "trend":    [{ "date": "2026-08-12", "users": 38 }],
    "byMarket": [{ "marketId": "5a9e…", "code": "IN", "name": "India", "users": 21032, "newUsers": 640 }]
  },

  "orders": {
    "total": 18420, "new": 640, "growthPercentage": 6.1,
    "pendingPayment": 84, "paid": 120, "processing": 210, "shipped": 340,
    "delivered": 17400, "cancelled": 220, "refunded": 166,
    "trend":    [{ "date": "2026-08-12", "orders": 19 }],
    "byMarket": [{ "marketId": "5a9e…", "orders": 8200, "newOrders": 310 }]
  },

  "finance": {
    "grossRevenue":     { "USD": "84210.00" },
    "collectedRevenue": { "USD": "81900.00" },
    "refundedAmount":   { "USD": "3200.00" },
    "netRevenue":       { "USD": "78700.00" },
    "costOfGoods":      { "USD": "34200.00" },
    "gatewayFees":      { "USD": "2380.00" },
    "royalties":        { "USD": "19010.00" },
    "profit":           { "USD": "23110.00" }
  },

  "payments": { "successful": 612, "pending": 14, "initiated": 3, "failed": 9,
                "needsReview": 5, "amount": { "USD": "81900.00" } },

  "refunds":  { "requested": 210, "awaitingReturn": 12, "approved": 30,
                "processed": 166, "rejected": 14, "amount": { "USD": "3200.00" } },

  "markets": [
    { "marketId": "5a9e…", "code": "IN", "name": "India", "currency": "INR",
      "users": 21032, "newUsers": 640, "orders": 8200, "newOrders": 310,
      "revenue": { "INR": "1980000.00" } }
  ],

  "products": {
    "total": 340, "new": 12,
    "draft": 12, "submitted": 4, "inReview": 3, "approved": 6, "rejected": 2,
    "published": 40, "active": 210, "ended": 55, "archived": 8,
    "inventory": [
      { "productId": "p-991…", "name": "Neon Drift #002", "totalSupply": 500,
        "reserved": 12, "committed": 8, "claimed": 310, "sold": 330, "available": 170 }
    ]
  },

  "content": { "totalBundles": 86, "activeBundles": 74, "newBundles": 6,
               "unlocksThisPeriod": 1420, "avgAccessCount": 3.2 },
  "artists": { "total": 512, "active": 470, "new": 8, "public": 390 },
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
    { "id": "gc-1…", "scope": "PLATFORM", "gateway": "STRIPE", "isDefault": true,
      "status": "ACTIVE", "organizationId": null, "createdAt": "…", "updatedAt": "…" }
  ],

  "activity": [
    { "eventId": "e91a…", "occurredAt": "2026-09-10T14:02:00.000Z",
      "type": "order.refund.approved", "actorId": "u-772…",
      "actorRoleSnapshot": "HITBOX_FINANCE_ADMIN",
      "resourceType": "RefundRequest", "resourceId": "r-441…",
      "actionResult": "SUCCESS", "severity": "INFO" }
  ]
}
```

### Gotchas

- **`growthPercentage` can be `null`** when the previous window had no data.
  Render that differently from `0` — "no baseline" is not "flat".
- **`activity[].actorRoleSnapshot` is the role the actor held at the time.**
  Render that, not their current roles. A since-revoked Finance Admin's past
  approval must still read "Finance Admin approved this".
- **`paymentGatewayConfig` never includes credentials.** There is no
  `credentialsRef` field and there never will be; the design's "Credentials are
  never returned by the API" caption is literal.
- The design's profit panel lists USD / GBP / INR as separate rows. That is
  `finance.profit` — one row per key present, in whatever order you choose.

---

## 2. Markets

**Design: PDF page 2.**

```http
GET /api/v1/admin/dashboard/markets?period=month
```

Requires `reports-dashboards:read` **plus** order or buyer access — it is a
re-slice of data you can already see, so it grants nothing new.

Envelope: `{ "data": [ … ] }`

```json
{ "data": [
  { "marketId": "5a9e…", "code": "IN", "name": "India", "currency": "INR",
    "users": 21032, "newUsers": 640, "orders": 8200, "newOrders": 310,
    "revenue": { "INR": "1980000.00" } }
] }
```

The design's table columns map directly: `name` → Market, `currency` →
Currency, `users` → Buyers, `newUsers` → New buyers, `orders` → Orders,
`newOrders` → New orders, `revenue` → Revenue. The Orders bar chart on the
right is the same array, sorted by `orders` descending — no second call.

> **Managing markets** (create / edit / archive, country mappings, the default
> market) is `/api/v1/admin/markets` — see
> [admin-write-apis.md 1](admin-write-apis.md). Writes require a
> platform-wide grant; this reporting endpoint does not.

> `revenue` is keyed by the market's own currency, so each row carries exactly
> one key. Render `revenue[row.currency]`.

---

## 3. Orders

**Design: PDF page 3.**

```http
GET /api/v1/admin/dashboard/orders?period=month&status=SHIPPED&page=1&limit=50
```

Requires `order:read`. Envelope: `{ page, limit, total, items[] }`.

| Param | Values |
|---|---|
| `status` | `PENDING_PAYMENT` `PAID` `PROCESSING` `SHIPPED` `DELIVERED` `CANCELLED` `REFUNDED` |
| `marketId` | uuid |
| `page`, `limit` | `limit` max 100 |

```jsonc
{
  "id": "o-1111-0000-…", "status": "DELIVERED", "quantity": 3,
  "marketId": "5a9e…", "organizationId": "org-1…",
  "productId": "p-0003…", "skuId": "sku-402…",
  "placedAt": "2026-09-11T05:30:00.000Z",
  "shippedAt": "…", "deliveredAt": "2026-09-16T05:30:00.000Z",

  "amount": "448.00", "currency": "USD",   // only with payment-royalty:read
  "buyerId": "3f2a9b11-1c4d-4e5f-8a9b-0c1d2e3f4a5b"  // only with buyer-profile:read
}
```

> **There is now a richer orders surface.** `/api/v1/admin/orders` resolves
> the buyer's **email** and the product's **code** at the database instead of
> returning bare ids, adds a full single-order detail with its SKU unit
> allocation, and exposes the status-change endpoint. See
> [admin-write-apis.md 2](admin-write-apis.md). Prefer it for this screen;
> the dashboard sub-endpoint below stays for the aggregate view.

### The two fields that vary by permission

This screen is the canonical example of field-level filtering:

- **`amount` / `currency`** appear only with `payment-royalty:read`. An Order
  Manager sees the order list with no money column at all — design the table so
  the Amount column can be absent, not zero-width or `—`.
- **`buyerId`** appears only with `buyer-profile:read`, and is **truncated to
  8 characters + ellipsis** (`3f2a9b11…`) unless the caller holds FULL
  visibility. The design shows full-looking ids; expect the short form.

`deliveredAt` is `null` for anything not yet delivered — the design's `—`.

---

## 4. Finance

**Design: PDF page 4.**

```http
GET /api/v1/admin/dashboard/finance?period=month
```

Requires `payment-royalty:read`. Envelope: `{ "data": { … } }`. Same shape as
the aggregate's `finance` key.

The screen's structure follows the data exactly:

- **Three per-currency cards (GBP / INR / USD)** — one card per key present
  across the figures. Iterate the union of currency keys; do not hardcode three.
- **Profit as % of net revenue** — computed client-side:
  `profit[cur] / netRevenue[cur]`.
- **"Collected of gross" / "Profit of net" progress bars** —
  `collectedRevenue[cur] / grossRevenue[cur]` and `profit[cur] / netRevenue[cur]`.
- **Deductions list** — `costOfGoods`, `gatewayFees`, `royalties`,
  `refundedAmount`.
- **"All figures, every currency" table** — the raw payload, one column per
  currency.

> The banner in the design — *"There is no FX rate in the system, so currencies
> are never combined"* — is a true statement about the API, not a UI nicety.
> Keep it.

Definitions, because they are easy to get wrong:

| Field | Means |
|---|---|
| `grossRevenue` | Sum of `Order.amount` |
| `collectedRevenue` | **Succeeded payments only** |
| `refundedAmount` | **Processed refunds only** — not requested or approved |
| `netRevenue` | `collected − refunded` |
| `profit` | `net − costOfGoods − gatewayFees − royalties` |

---

## 5. Resale

**Design: PDF page 5.**

```http
GET /api/v1/admin/dashboard/resale?status=ACTIVE&page=1&limit=50
```

Requires `order:read`. Envelope: `{ page, limit, total, counts, items[] }`.

```jsonc
{
  "page": 1, "limit": 20, "total": 64,
  "counts": { "ACTIVE": 15, "SOLD": 23, "WITHDRAWN": 14, "BLOCKED": 12 },
  "items": [
    { "id": "rl-1…", "skuId": "sku-427…", "status": "BLOCKED",
      "createdAt": "2026-09-10T00:00:00.000Z",
      "price": "242.00", "currency": "GBP" }   // only with payment-royalty:read
  ]
}
```

`counts` drives the four KPI cards at the top and is **unfiltered** — it always
reflects every status, regardless of the `status` query param. That is what
makes the cards usable as a filter control.

> **Gap:** the design's table shows a product name (*"Halcyon Bomber"*) and a
> seller id. The API returns `skuId` only. You need a second lookup per row, or
> ask for the endpoint to be widened — see 15.

---

## 6. Buyers

**Design: PDF page 6.**

```http
GET /api/v1/admin/dashboard/users?period=month
```

Requires `buyer-profile:read`. Envelope: `{ "data": { … } }`. Same shape as the
aggregate's `users` key.

| Design element | Key |
|---|---|
| Total buyers + `+12.4%` chip + sparkline | `total`, `growthPercentage`, `trend` |
| New this period | `new` |
| Active / "2,121 inactive" | `active`, `inactive` |
| Admins / "23 added this period" | `totalAdmins`, `newAdmins` |
| "New buyers" chart | `trend` |
| Active vs inactive bars | `active`, `inactive` (denominator `total`) |
| By market table | `byMarket[]` |

The design's **Share %** column is computed client-side:
`byMarket[i].users / total`.

> `newAdmins` / `totalAdmins` require `employee-role-mgmt:read` as well. A
> caller with only `buyer-profile:read` gets the buyer halves and no admin
> counts — hide those two cards rather than showing `0`.

---

## 7. Products

**Design: not in the PDF** — the sidebar has the entry but no page was
supplied. The endpoint exists; build against the contract below and confirm the
layout with design.

```http
GET /api/v1/admin/dashboard/products?status=ACTIVE&page=1&limit=50
```

Requires `drop:read`. Envelope: `{ page, limit, total, items[] }`. Items are
the same inventory shape the dashboard previews:

```json
{ "productId": "p-991…", "name": "Neon Drift #002", "totalSupply": 500,
  "reserved": 12, "committed": 8, "claimed": 310, "sold": 330, "available": 170 }
```

**The detail screen** is `GET /api/v1/admin/products/:id` — the catalog
record plus performance aggregates plus a paginated page of serialized SKU
units, in one call. Catalog CRUD is `POST`/`PATCH`/`DELETE` on the same base.
Both in [admin-write-apis.md 3](admin-write-apis.md).

> ⚠ **The write routes moved.** `POST`/`PATCH`/`DELETE /api/v1/products`
> previously sat behind `requireAuth` alone — any signed-in buyer could create
> or archive a drop. They now live at `/api/v1/admin/products` behind a
> platform-wide capability. `GET /api/v1/products` stays public and read-only.

Note the catalog recently changed shape: `productCode` → `groupCode`, the
category/rarity enums became free-form strings, and price moved to per-market
`ProductPrice` rows — see [api-reference.md](../api-reference.md).

---

## 8. Supply

**Design: PDF page 7.**

```http
GET /api/v1/admin/dashboard/supply?vendorId=…&page=1&limit=50
```

Requires `drop:read`. Envelope: `{ page, limit, total, activeVendors, items[] }`.

```json
{
  "page": 1, "limit": 20, "total": 118, "activeVendors": 4,
  "items": [
    { "id": "sb-1…", "vendorId": "v-9…", "itemType": "…", "quantity": 1186,
      "batchRef": "…", "receivedAt": "2026-10-31T00:00:00.000Z", "notes": null,
      "vendor": { "name": "Meridian Knitworks", "vendorType": "…" } }
  ]
}
```

`activeVendors` is the design's *"4 active vendors"* caption.

> **Gap:** the design's table shows Product, Status (`Partial` / `Ordered` /
> `Received` / `Delayed` / `In transit`), Ordered, Received and Expected. The
> API returns `quantity`, `receivedAt` and a vendor name — there is **no
> product name, no status enum, and no ordered-vs-received split**. This screen
> cannot be built as designed against the current endpoint. See 15.

---

## 9. Demand signals

**Design: PDF page 8.**

```http
GET /api/v1/admin/dashboard/demand-signals
```

Requires `drop:read`. Envelope: `{ "data": [ … ] }`. Returns the **top 10**
products by wishlist count; there is no pagination and no period filter.

```json
{ "data": [
  { "productId": "p-991…", "name": "Midnight Runner LX", "wishlists": 796, "follows": 7502 }
] }
```

**Name mapping — the design and the API disagree on vocabulary:**

| Design column | API field |
|---|---|
| Watchers | `follows` |
| Waitlisted | `wishlists` |
| Watch → Waitlist | *computed:* `wishlists / follows` |

The conversion percentage is not returned; compute it. The design colours it
green above ~25% and grey below — that threshold is a UI decision, not
something the API expresses.

> `follows` counts follows of the product's **artist**, not of the product.
> That is what the underlying query does. Label it accordingly, or treat the
> column as "artist reach" rather than per-product watchers.

---

## 10. Content

**Design: PDF page 9.**

There is **no `/admin/dashboard/content` sub-endpoint.** Take the `content` and
`artists` keys from the aggregate:

```http
GET /api/v1/admin/dashboard?period=month
```

Requires `content-unlock:read` for `content`, `brand-artist-record:read` for
`artists`.

```json
{
  "content": { "totalBundles": 86, "activeBundles": 74, "newBundles": 6,
               "unlocksThisPeriod": 1420, "avgAccessCount": 3.2 },
  "artists": { "total": 512, "active": 470, "new": 8, "public": 390 }
}
```

| Design element | Source |
|---|---|
| Active bundles "74 of 86 total" | `content.activeBundles` / `content.totalBundles` |
| New this period | `content.newBundles` |
| Unlocks "1.4K" | `content.unlocksThisPeriod` |
| Avg. access count | `content.avgAccessCount` |
| Bundle health bars | `activeBundles/totalBundles`, `unlocksPerActiveBundle` *(computed)* |
| Artists panel | `artists.total`, `.active`, `.public`, `.new` |

The design's *"19 / 50 unlocks per active bundle"* bar has no API field — the
numerator is `unlocksThisPeriod / activeBundles` and the `50` denominator is a
UI-chosen target. Confirm that target with design before shipping it.

---

## 11. Media

**Design: PDF page 10.**

```http
GET /api/v1/admin/media?assetType=DROP_IMAGE&page=1&limit=50
```

Requires `assets-documents-upload:read`. Full upload flow, size caps, CORS and
bucket setup: [admin-api-reference.md 6](admin-api-reference.md) and
[media/s3-configuration.md](../media/s3-configuration.md).

```jsonc
{
  "page": 1, "limit": 20, "total": 78,
  "byType": { "DROP_IMAGE": 40, "LEGAL_DOCUMENT": 12, "SUPPLY_SPREADSHEET": 9 },
  "byScanStatus": { "SKIPPED": 74, "CLEAN": 4 },
  "items": [
    { "assetId": "a-771f…", "assetType": "LEGAL_DOCUMENT", "fileName": "contract-21.pdf",
      "storageRef": "legal-documents/products/p-9989/a-7917.pdf",
      "publicUrl": null,
      "mimeType": "application/pdf", "sizeBytes": 19188838,
      "virusScanStatus": "SKIPPED",
      "productId": "p-9989…", "collectionId": null, "organizationId": "org-1…",
      "artistId": null, "uploadedById": "u-220…",
      "archivedAt": null, "createdAt": "2026-09-10T12:00:00.000Z" }
  ]
}
```

### ⚠ The design shows a scan pipeline that does not exist

The mock has **Clean / Pending / Infected / Skipped** cards and a banner:
*"4 assets are still processing. They are not servable until the scanner marks
them clean — this list refreshes automatically."*

**There is no virus scanner in this deployment.** No SQS, no scan worker, no
scan callback. Every asset uploaded now is created `SKIPPED`, which is
immediately servable. Concretely:

- **Do not build the processing banner.** Nothing will ever move out of it.
- **Do not poll this list.** There is no state transition to wait for.
- **Do not gate rendering on `virusScanStatus === "CLEAN"`.** `CLEAN` appears
  only on rows predating the change. Treat `CLEAN` **and** `SKIPPED` as
  servable; `PENDING` and `INFECTED` as not.
- The four KPI cards will read `Skipped: 78, Clean: 0, Pending: 0, Infected: 0`.
  Consider collapsing them to a single count, or keep them and accept three
  permanent zeroes. Ask design.

`byScanStatus` is still returned, so the cards have a data source if you keep
them.

### Archive view

`?archived=live` (default) | `archived` | `all`. The recycle-bin view is
`?archived=archived`; archived rows carry a non-null `archivedAt`. See
[admin-write-apis.md 5](admin-write-apis.md).

### Public vs private URLs

`publicUrl` is non-null **only** for `DROP_IMAGE` and `PROFILE_IMAGE` — those
live under anonymously-readable S3 prefixes. Render it directly; it is
permanent and needs no per-render call.

For every other asset type it is `null`, and you must fetch a short-lived URL
per render:

```http
GET /api/v1/admin/media/:assetId/url
```

```jsonc
// public asset
{ "url": "https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/drop-images/…",
  "expiresIn": null, "public": true }

// private asset
{ "url": "https://…?X-Amz-Signature=…", "expiresIn": 60, "public": false }
```

**When `expiresIn` is a number, do not cache the URL** — fetch it at render
time. When it is `null` the URL is permanent and safe to store.

The eye icon in the design is this endpoint; the archive icon is
`DELETE /api/v1/admin/media/:assetId` (a **soft** archive — the row and the S3
object both survive).

> The *"Upload requires configured storage"* note in the design is real: on a
> deploy with no `MEDIA_S3_BUCKET`, every `/admin/media/*` route returns
> **503 `STORAGE_UNAVAILABLE`**. Handle it before building the upload button.

---

## 12. Provenance

**Design: PDF page 11.**

```http
GET /api/v1/admin/dashboard/provenance?caseType=CLONED&status=OPEN&page=1&limit=50
```

Requires `nfc-tag-claim:read` (or `collectible-instance:read`).
Envelope: `{ page, limit, total, summary, items[] }`.

| Param | Values |
|---|---|
| `caseType` | `COUNTERFEIT` `STOLEN` `CLONED` `TAMPERED` |
| `status` | `OPEN` `INVESTIGATING` `RESOLVED` |

```json
{
  "page": 1, "limit": 20, "total": 58,
  "summary": { "cases": { "OPEN": 33, "INVESTIGATING": 18, "RESOLVED": 7 } },
  "items": [
    { "id": "sc-137…", "caseType": "COUNTERFEIT", "status": "INVESTIGATING",
      "tagId": "04A2237FE", "skuId": "sku-402…",
      "reporterId": "u-556f21…",
      "description": "Buyer reports the collectible was not the one shipped.",
      "resolvedAt": null, "createdAt": "2026-09-09T08:30:00.000Z",
      "sku": { "tagLifecycleState": "DISPUTED", "tamperStatus": "counter_regression",
               "claimedStatus": "FLAGGED" } }
  ]
}
```

The design's **SKU STATE** column shows one or two pills — those are
`sku.tagLifecycleState` (e.g. `Disputed`, `Active`) and, when non-null,
`sku.tamperStatus` (e.g. `counter_regression`). Render `tamperStatus` only when
present.

The three KPI cards are `summary.cases`, which — like resale's `counts` — is
unfiltered.

> This screen is **read-only** today. There is no endpoint to open, assign,
> escalate or resolve a case. See 15.

---

## 13. Audit log

**Design: PDF page 12.**

```http
GET /api/v1/admin/dashboard/activity?severity=CRITICAL&page=1&limit=50
```

Requires `audit-log:read`. Envelope: `{ page, limit, total, items[] }`.

| Param | Values |
|---|---|
| `severity` | `INFO` `WARNING` `CRITICAL` |
| `period`, `from`, `to` | as 0 |

```json
{ "eventId": "e91a…", "occurredAt": "2026-09-10T14:02:00.000Z",
  "type": "authz.role.assigned", "actorId": "u-780f21…",
  "actorRoleSnapshot": "HITBOX_SYSTEM_ADMIN",
  "resourceType": "RoleAssignment", "resourceId": "ra-406…",
  "actionResult": "SUCCESS", "severity": "INFO" }
```

The design renders each row as **verb + event type + actor role + ids + relative
time**. The human verb (*Assigned*, *Revoked*, *Published*, *Approved*) is the
last segment of `type` — derive it client-side:

```ts
const verb = { assigned: 'Assigned', revoked: 'Revoked', published: 'Published',
               approved: 'Approved', updated: 'Updated', changed: 'Changed',
               adjusted: 'Adjusted', opened: 'Opened', uploaded: 'Uploaded' };
const key = event.type.split('.').pop();          // "assigned"
const label = verb[key] ?? key;
```

**Render `actorRoleSnapshot`, never the actor's current roles.** This is the
whole point of the audit log: it must remain truthful about who held what at
the time. The design's *"System Admin · u-780f21…"* line is
`actorRoleSnapshot` + `actorId`.

The Dashboard's "Recent activity" panel (1) is the same data capped at 20; its
"Full audit log →" link lands here.

---

## 14. Publish drop

**Design: PDF page 13.** — ⚠️ **Partially built.**

`packages/releases` **now exists**: the review queue, approval detail with full
history, amend, and the approve/reject decision are all implemented at
`/api/v1/admin/releases` — see
[admin-write-apis.md 4](admin-write-apis.md). Product creation and editing
are at `/api/v1/admin/products` (3 there).

What is still missing is the **publish step itself** and the wizard's media and
pricing joins.

What exists today, and what it does not cover:

| Design element | Status |
|---|---|
| "Awaiting Launch 20 / Active on Market 12" stats | ✅ `products` section of 1 (`approved`, `active`) |
| "Ready Queue" / "Live Drops" tabs | ✅ `GET /admin/dashboard/products?status=…` |
| Compliance sign-off "100% Verified" | ✅ `GET /admin/releases?latestOnly=true` |
| Step 1 — Drop identification & brand | ✅ `POST /api/v1/admin/products`; brand and artist pickers from `GET /admin/organizations` and `GET /admin/artists` ([product-upload-api.md 4](product-upload-api.md)) |
| Step 1b — edition size / serialized units | ✅ `POST /admin/products` with a `skus` block, or `POST /admin/products/:productId/skus` — [sku-api.md](sku-api.md) |
| Step 2 — Artwork & media upload | ✅ `POST /admin/media/upload-url` then `POST /admin/products/:id/images` — multi-image gallery with ordering and a primary flag ([product-upload-api.md 3](product-upload-api.md)) |
| Live marketplace preview — price | ✅ `prices[]` on create (at least one required) and `PUT /admin/products/:id/prices` — one row per market ([product-upload-api.md 3](product-upload-api.md)) |
| Submit for review | ✅ `POST /api/v1/admin/releases` |
| Approve / reject | ✅ `POST /api/v1/admin/releases/:id/decision` |
| "Deploy New Drop" / publish action | ❌ **nothing** — no `APPROVED → PUBLISHED/ACTIVE` transition |
| NFC tag claims "Enabled" toggle | ⚠️ tags are bound at mint time via `tagIds` ([sku-api.md 3](sku-api.md)); there is no per-drop toggle and no way to bind a tag to an already-minted unit |

**One endpoint still missing before this screen is buildable end to end:**

1. `POST /admin/products/:id/publish` — `APPROVED` → `PUBLISHED`/`ACTIVE`
   with `releaseStart`/`releaseEnd`

The image join and the per-market price upsert (both previously listed here)
are **built** — see [product-upload-api.md](product-upload-api.md) 3 and 4.
Everything else on the wizard is live.

---

## 15. Roles

**Design: PDF pages 14 (list) and 15 (new role).**

```http
GET    /api/v1/admin/authz/roles?domain=BUSINESS
GET    /api/v1/admin/authz/roles/:roleId
POST   /api/v1/admin/authz/roles
PATCH  /api/v1/admin/authz/roles/:roleId
DELETE /api/v1/admin/authz/roles/:roleId
GET    /api/v1/admin/authz/permissions?shape=grouped
```

Read routes require `employee-role-mgmt:read`; **all writes require
`employee-role-mgmt:manage` at `:global`** — defining a role is strictly
stronger than assigning one (so `:assign` is not enough), and a role definition
applies platform-wide (so an organization-scoped grant is not enough either).
Full contract in [admin-write-apis.md 6](admin-write-apis.md).

`GET /admin/authz/roles` already returns each role's **full permission list**;
no second call is needed to render its capabilities.

### List (page 14)

```json
{ "data": [
  { "id": "r-1…", "name": "HITBOX_SYSTEM_ADMIN", "displayName": "System Admin",
    "domain": "BUSINESS", "entityGroup": "hitbox",
    "permissionCount": 17, "assignedCount": 23,
    "isActive": true, "isSystem": true }
] }
```

The design's columns map directly. The **lock icon** next to a role name is
`isSystem: true` — those are seeded roles and must render read-only. The
`Active` / `Inactive` pill is `isActive`; deactivating a role kills it
everywhere at once, which is why it is a toggle rather than a delete.

### New role (page 15)

```jsonc
// POST /api/v1/admin/authz/roles
{
  "name": "BRAND_CONTENT_EDITOR",        // SCREAMING_SNAKE_CASE, immutable after creation
  "displayName": "Brand Content Editor",
  "entityGroup": "brand_artist",         // decides the natural scope when assigned
  "domain": "BUSINESS",                  // BUSINESS | TECHNICAL
  "permissionIds": ["p-1…", "p-2…"]
}
```

Build the permission picker from `GET /admin/authz/permissions?shape=grouped`,
which returns permissions grouped by resource — the design's collapsible
`Orders ORDER`, `Finance PAYMENT_ROYALTY`, `Media ASSETS_DOCUMENTS_UPLOAD`
rows. **Never free-text a permission string**; the catalog is the source of
truth and unknown strings are rejected.

> **Every permission on a role must belong to the role's domain.** The design
> states this under the Business/Technical toggle. Filter the picker by the
> selected domain, or the `POST` fails validation.

---

## 16. Team

**Design: PDF page 16.**

```http
GET /api/v1/admin/authz/team?search=ana&page=1&limit=20
```

Requires `employee-role-mgmt:read`. Envelope: `{ page, limit, total, items[] }`.

```json
{
  "page": 1, "limit": 20, "total": 142,
  "items": [
    { "userId": "3f2a9b18-1c4d…", "fullName": "Ana Duarte", "handle": "ana",
      "email": "ana.duarte@hitbox.demo", "avatarUrl": null,
      "isActive": true, "joinedAt": "2026-02-15T00:00:00.000Z",
      "roles": [
        { "assignmentId": "ra-1…", "roleId": "r-1…", "name": "HITBOX_SYSTEM_ADMIN",
          "displayName": "System Admin", "domain": "BUSINESS",
          "scopeType": "GLOBAL", "organizationId": null,
          "grantedAt": "2026-02-15T00:00:00.000Z" },
        { "assignmentId": "ra-2…", "roleId": "r-6…", "name": "HITBOX_SUPPORT",
          "displayName": "Support", "domain": "BUSINESS",
          "scopeType": "GLOBAL", "organizationId": null,
          "grantedAt": "2026-03-01T00:00:00.000Z" }
      ] }
  ]
}
```

"Team" means anyone holding at least one live role — the admin population is
defined by grants, not by a flag on the user row. `search` matches full name,
email or handle, case-insensitively.

**`internalOnly` defaults to `true`**, so the list shows only HitBox internal
staff (roles whose `entityGroup` is `hitbox_seller_org`). Pass
`internalOnly=false` to include brand and artist role-holders. Each role now
also carries `entityGroup` and `isSystem`. Full contract, including assign and
revoke, in [admin-write-apis.md 7](admin-write-apis.md).

One row per person, with roles nested. A person can hold several roles at once
(the design shows *Ana Duarte — System Admin, Support*); their effective
permissions are the **union**. Nothing merges roles or creates combined ones.

### Manage roles

The design's per-row "Manage roles" button drives:

```http
GET    /api/v1/admin/authz/users/:userId/roles
POST   /api/v1/admin/authz/users/:userId/roles
DELETE /api/v1/admin/authz/users/:userId/roles/:roleId?organizationId=…
```

```jsonc
// POST body
{ "roleId": "r-1…", "organizationId": "org-1…" }  // required for ORG scope, forbidden otherwise
```

`POST` requires `employee-role-mgmt:assign`; `DELETE` requires
`employee-role-mgmt:delete`.

> **Revoking is a soft delete** — the design says so, and it is literal. The
> assignment row survives with `revokedAt` set, so the audit trail can still
> answer "who held what in March". Pass `?includeRevoked=true` to
> `GET /users/:userId/roles` to show history.

**Org-scoped assigners are constrained by the engine:** a Brand Admin calling
`POST` with an `organizationId` outside their own reach gets a `403`, and their
`GET /admin/authz/team` is already narrowed to their organizations. You do not
need to filter client-side.

---

## 17. The "View as" header control

Every screen's header has a **View as: System Admin** dropdown.

**There is no backend support for this.** No impersonation endpoint, no
`?viewAs=` parameter, no role-preview mode. `GET /authz/me` returns the
caller's own effective permissions and nothing else.

Options, in order of preference:

1. **Drop it** for v1 and revisit when there is a real need.
2. **Client-side preview only** — fetch the target role's permission list from
   `GET /admin/authz/roles/:roleId` and re-render the *navigation* against it.
   Data still comes back scoped to the real caller, so the preview is
   structurally honest but not data-accurate. Label it clearly.
3. **Real impersonation** — needs a new endpoint, its own capability, and an
   audit event per session. Treat it as a feature, not a toggle.

Do not implement it by sending a role name to the API. Nothing on the server
reads one — authorization is resolved from the caller's own grants on every
request.

---

## 18. Known gaps — summary

Raise these before sprint planning; four screens cannot be built exactly as
designed.

| # | Screen | Gap | Severity |
|---|---|---|---|
| 1 | Publish drop (14) | ~~Entire backend missing~~ → **review workflow now built**; product-image join, price upsert and the publish transition remain | Major |
| 2 | Media (11) | Design assumes a virus scanner; none exists | **Redesign needed** |
| 3 | Supply (8) | No product name, status enum, or ordered/received split | **Blocker for this layout** |
| 4 | Provenance (12) | Read-only — no open/assign/resolve actions | Major |
| 5 | Resale (5) | Items carry `skuId` only, no product name or seller | Major |
| 6 | Products (7) | No design page supplied — the API now exists | Needs design |
| 7 | View as (17) | No backend support | Needs a decision |
| 8 | Demand signals (9) | `follows` counts artist follows, not product watchers | Label carefully |
| 9 | Content (10) | No sub-endpoint; "unlocks per bundle" target is invented | Minor |

**Closed since the first draft:** Markets CRUD, order detail + status changes,
product detail + CRUD, the release approval workflow, the media archive view,
role editing gates and the Team screen's staff filter — all in
[admin-write-apis.md](admin-write-apis.md).

---

## 19. Integration checklist

- [ ] Build the sidebar from `/authz/me`, never from a role name
- [ ] Treat a **missing key** as "not permitted" and an **empty value** as "no data" — show them differently
- [ ] Render money per currency; never add `USD + INR`
- [ ] Handle `growthPercentage: null` (no baseline) distinctly from `0`
- [ ] Expect `amount`/`buyerId` to be absent on `/orders` for some callers
- [ ] Expect `buyerId` truncated to `3f2a9b11…` unless FULL visibility
- [ ] Use `actorRoleSnapshot` in the audit feed, not the actor's current roles
- [ ] Store `publicUrl` for drop/profile images; re-fetch only when `expiresIn` is non-null
- [ ] Treat media `SKIPPED` as servable — do **not** wait for `CLEAN`
- [ ] Always send `sizeBytes: file.size` when requesting an upload URL (required)
- [ ] PUT to S3 with the exact `Content-Type` you declared, or the signature fails
- [ ] Render the permission tree from `/admin/authz/permissions`; never free-text a permission
- [ ] Filter the permission picker by the role's `domain` when editing a role
- [ ] Show `isSystem: true` roles as read-only
- [ ] Support multiple roles per person in the Team UI
- [ ] Handle `503 STORAGE_UNAVAILABLE` on every media route
