# Order Unit Assignment API — scan-to-assign at packing

> **What this solves:** a drop like "T-Shirt, Red, Size S" can have 500
> physically identical shirts, each with its own NFC tag. At checkout the
> system holds *a* shirt for the order — but nobody in the warehouse can find
> "the one with tag 123" among 500. So the physical item is chosen **at
> packing**: the packer takes **any** Red S shirt, scans its tag, and the order
> is bound to exactly that tag. The buyer later taps that same tag to claim it.
>
> Payments, refunds and the order's money summary:
> [order-payments-and-refunds-api.md](order-payments-and-refunds-api.md).
>
> Related: the order list/detail and status changes —
> [admin/admin-write-apis.md](../admin/admin-write-apis.md); minting units and
> binding tags — [admin/sku-api.md](../admin/sku-api.md); claiming —
> [nfc-claim-verify-api.md](../nfc-claim-verify-api.md).

---

## Contents

1. [The idea in one picture](#1-the-idea-in-one-picture)
2. [Quick start](#2-quick-start)
3. [Endpoints](#3-endpoints)
4. [`GET /admin/orders/fulfilment-queue` — orders waiting to be packed](#4-get-adminordersfulfilment-queue--orders-waiting-to-be-packed)
5. [`GET /admin/orders/:orderId/unit` — an order's packing state](#5-get-adminordersorderidunit--an-orders-packing-state)
6. [`POST /admin/orders/:orderId/unit` — scan an item for this order](#6-post-adminordersorderidunit--scan-an-item-for-this-order)
7. [`POST /admin/orders/assign-by-scan` — scan first, server picks the order](#7-post-adminordersassign-by-scan--scan-first-server-picks-the-order)
8. [What changed in existing endpoints](#8-what-changed-in-existing-endpoints)
9. [The checks on a scanned unit](#9-the-checks-on-a-scanned-unit)
10. [Consistency — how the swap stays safe](#10-consistency--how-the-swap-stays-safe)
11. [Common situations](#11-common-situations)
12. [Who can call this](#12-who-can-call-this)
13. [Errors](#13-errors)
14. [Setup](#14-setup)
15. [Where the code lives](#15-where-the-code-lives)
16. [Packing-screen checklist](#16-packing-screen-checklist)

All paths are under **`/api/v1`** and need a Clerk session.

---

## 1. The idea in one picture

```
CHECKOUT                       PAYMENT                    PACKING                         DELIVERY
────────                       ───────                    ───────                         ────────
Buyer orders "Red / S"   →     order PAID            →    packer grabs ANY Red/S    →     buyer taps the tag
system holds a placeholder     placeholder unit           shirt, scans its tag            → claims exactly the
unit (#1) so stock can't       still PROVISIONAL          → order bound to THAT unit        unit on the order
be oversold                                               → placeholder #1 back in stock
                                                          → order PROCESSING, ready to ship
```

| Term | Meaning |
|---|---|
| **Placeholder / provisional unit** | The unit checkout held (lowest free serial). It guarantees stock. It is **not** necessarily the shirt that ships |
| **Assigned unit** | The unit a packer scanned and the server confirmed. This is the one in the parcel |
| `unitState` | `PROVISIONAL` (paid, nothing scanned), `ASSIGNED` (scanned, confirmed), `NONE` (holds no stock) |

**An order cannot be marked `SHIPPED` until its unit is assigned.**

---

## 2. Quick start

**Order first** (the packer works through a list):

```http
GET  /api/v1/admin/orders/fulfilment-queue              ← oldest waiting order first
POST /api/v1/admin/orders/{orderId}/unit                ← packer scans a shirt
     { "tagId": "04A1B2C3D4E5F6" }
POST /api/v1/admin/orders/{orderId}/shipment           ← then ship with the tracking number
     { "carrierName": "DHL Express", "trackingNumber": "7741…" }
```

**Scan first** (the packer picks up a shirt and asks "who is this for?"):

```http
POST /api/v1/admin/orders/assign-by-scan
     { "tagId": "04A1B2C3D4E5F6" }                       ← assigned to the oldest waiting order for that variant
```

---

## 3. Endpoints

| Method | Path | Capability | What it does |
|---|---|---|---|
| `GET` | `/admin/orders/fulfilment-queue` | `order:read` | Paid orders waiting for a scanned unit, oldest first |
| `GET` | `/admin/orders/:orderId/unit` | `order:read` | One order's packing state |
| `POST` | `/admin/orders/:orderId/unit` | `order:manage` | Scan a unit **for this order** |
| `POST` | `/admin/orders/assign-by-scan` | `order:manage` | Scan a unit; the server picks the oldest waiting order for it |

Every successful scan returns the order's updated packing state (§5).

---

## 4. `GET /admin/orders/fulfilment-queue` — orders waiting to be packed

Orders that are `PAID` or `PROCESSING`, hold stock, and have **no assigned
unit yet** — oldest `placedAt` first (first come, first packed).

| Query | Notes |
|---|---|
| `productId` | Only this drop |
| `variantId` | Only this variant — e.g. work through all "Red / S" orders while standing at that bin |
| `page`, `limit` | Default 1 / 20, `limit` max 100 |

```json
{
  "page": 1,
  "limit": 20,
  "total": 37,
  "items": [ { …packing state, see §5… } ]
}
```

Scoped like the order list: a caller limited to some organizations sees only
their orders.

---

## 5. `GET /admin/orders/:orderId/unit` — an order's packing state

```json
{
  "data": {
    "orderId": "8c1e…",
    "publicCode": "odr0h2k9m4p7x3f8q2n",
    "status": "PAID",
    "productId": "6f1c…",
    "productCode": "123456780000",
    "productName": "Lumen Tour Tee",
    "variantId": "a91b…",
    "variantLabel": "S / Red",
    "variantCode": "123456780000-S-RED",
    "unitState": "PROVISIONAL",
    "unit": {
      "skuId": "1d0f…",
      "skuCode": "123456780000-000001",
      "serialNumber": 1,
      "tagId": "04A1B2C3D4E5F6",
      "variantId": "a91b…"
    },
    "unitAssignedAt": null,
    "unitAssignedById": null,
    "readyToShip": false,
    "placedAt": "2026-10-14T09:00:00.000Z"
  }
}
```

| Field | Meaning |
|---|---|
| `variantLabel` | **What to pick** — show this big on the packing screen |
| `unitState` | `PROVISIONAL` → scan an item. `ASSIGNED` → already packed. `NONE` → nothing to pack (unpaid / cancelled) |
| `unit` | `ASSIGNED`: the unit in the parcel. `PROVISIONAL`: only the placeholder — **don't go looking for it**, pick any matching item |
| `unitAssignedAt` / `unitAssignedById` | When and by whom it was scanned |
| `readyToShip` | `true` when assigned and `PROCESSING` |

---

## 6. `POST /admin/orders/:orderId/unit` — scan an item for this order

Send **exactly one** way of identifying the item:

```json
{ "tagId": "04A1B2C3D4E5F6" }
```
```json
{ "skuCode": "123456780000-000214" }
```
```json
{ "serialNumber": 214 }
```

| Field | When to use it |
|---|---|
| `tagId` | The NFC tag UID — packer taps the tag with a phone/reader. The strongest proof |
| `skuCode` | The code printed (as a barcode/QR) on the hang tag — fastest with a handheld scanner |
| `serialNumber` | The printed edition number. Only valid here, because a serial is unique per drop and the order says which drop |
| `replace` | `true` to swap a unit that is **already assigned** (wrong shirt packed, damage found). Default `false` |

**What happens on success, all in one transaction:**

1. The scanned unit is checked (§9).
2. The order's stock hold moves from the placeholder to the scanned unit. The
   placeholder goes **back into stock** immediately.
3. The order gets the scanned unit (`skuId`), `unitAssignedAt`, `unitAssignedById`.
4. A `PAID` order moves to `PROCESSING` (packed).

Response `200` — the packing state (§5) with `unitState: "ASSIGNED"`.

| Case | Result |
|---|---|
| Scanning the placeholder itself | Fine — it's confirmed as-is |
| Scanning the already-assigned unit again | No-op, `200` (a double scan isn't an error) |
| Scanning a **different** unit when one is assigned, without `replace` | `409 ORDERS_UNIT_ALREADY_ASSIGNED` — so a stray scan can't silently swap a parcel |
| Same, with `replace: true` | The new unit is assigned; the previous one goes back into stock |

Events: `orders.order.unit-assigned` `{ orderId, skuId, skuCode, previousSkuId, replaced, actorId }`,
plus `orders.order.status-changed` when it moved `PAID → PROCESSING`.

---

## 7. `POST /admin/orders/assign-by-scan` — scan first, server picks the order

```json
{ "tagId": "04A1B2C3D4E5F6" }
```
or `{ "skuCode": "123456780000-000214" }`. (`serialNumber` isn't accepted here —
without an order, a serial is ambiguous across drops.)

The server finds the **oldest** order that is waiting for exactly this unit's
drop **and variant**, and assigns the unit to it — same checks and same
transaction as §6. The response is that order's packing state, so the screen
shows which order (and address label) the item belongs to.

If no order is waiting for that variant: `404 ORDERS_NO_WAITING_ORDER` — put
the item back on the shelf.

---

## 8. What changed in existing endpoints

| Endpoint | Change |
|---|---|
| Shipping (`POST /admin/orders/:orderId/shipment`) | Refused with `400 ORDERS_UNIT_NOT_ASSIGNED` until the unit is scanned. (`PATCH …/status` → `SHIPPED` is no longer used; see [order-history-and-shipments.md](order-history-and-shipments.md)) |
| `GET /admin/orders/:orderId` | New field `unitAssignedAt`; `canRecordShipment` turns true once the unit is scanned |
| `GET /admin/orders` | New field `unitAssignedAt` on each item |
| `Order.skuId` (anywhere it's shown) | Before packing it's the **placeholder**. Treat it as final only once `unitAssignedAt` is set |
| Checkout response / Stripe metadata `skuId` | Also the placeholder — informational only |

Checkout, payment and claiming are otherwise unchanged. Orders already
`PROCESSING` before this release must be scanned once before they can ship
(scanning their current unit confirms it).

---

## 9. The checks on a scanned unit

A scan is refused unless the unit:

| Check | Error |
|---|---|
| exists | `404 ORDERS_UNIT_NOT_FOUND` |
| is the order's **drop and variant** (no Blue M in a Red S order) | `400 ORDERS_WRONG_ITEM` — `details.expected` vs `details.scanned` |
| is not archived or deactivated | `400 ORDERS_UNIT_UNAVAILABLE` |
| is unclaimed | `400 ORDERS_UNIT_UNAVAILABLE` |
| is not blocked | `400 ORDERS_UNIT_UNAVAILABLE` |
| **has an NFC tag bound** (else the buyer could never claim it) | `400 ORDERS_UNIT_UNAVAILABLE` |
| has its tag in state `BOUND` (not `LOST`, `REVOKED`, `DISPUTED`, already `ACTIVE`) | `400 ORDERS_UNIT_UNAVAILABLE` |
| is **free**: on no other order and held by no other live reservation | `409 ORDERS_UNIT_UNAVAILABLE` |

And the order must be `PAID` or `PROCESSING` and hold stock
(`400 ORDERS_NOT_ASSIGNABLE` otherwise).

"Free" uses exactly the same rule as checkout, so a unit a packer can take is
precisely a unit checkout could have sold — the two can never disagree.

---

## 10. Consistency — how the swap stays safe

The swap is **one database transaction**:

1. Inside the transaction, re-check the scanned unit is free.
2. Move the order's reservation to the scanned unit — guarded on its current
   unit, so a concurrent swap of the same order fails.
3. Update the order — guarded on the status and unit that were read.
4. **Verify** that exactly one live hold and exactly one order now point at
   the scanned unit.

If two packers scan the **same shirt** for two orders at the same moment, both
pass step 1, but only one survives step 4; the other's transaction rolls back
completely and they get `409 ORDERS_ASSIGN_CONFLICT` ("scan again"). Nothing
is ever half-written: either the order, its hold and the unit all move
together, or nothing moves.

Stock is never at risk during the swap: the order always holds exactly one
unit — the placeholder before, the scanned unit after.

---

## 11. Common situations

| Situation | What to do |
|---|---|
| Packed the wrong shirt (noticed before shipping) | Scan the right one with `replace: true` |
| Shirt is damaged | Set it aside, scan another (`replace: true` if it was already scanned). Flag the damaged unit via the SKU inventory API ([sku-inventory-management.md](../admin/sku-inventory-management.md)) |
| Scanner says wrong item | It's a different variant — check the size/colour label |
| Shirt has no tag yet | `ORDERS_UNIT_UNAVAILABLE`: bind its tag first ([sku-api.md 3a](../admin/sku-api.md)) or use another shirt |
| Order cancelled after packing | Cancel as usual; the unit's fate (restock / quarantine) follows the cancellation/refund workflow |
| "Pick your number" drops (buyer chose serial #001) | Not covered here — those need the specific unit; scan it by `serialNumber` and verify it's the requested one |

---

## 12. Who can call this

Checked by capability, never role name.

| Role (seeded) | Queue / view (`order:read`) | Scan to assign (`order:manage`) |
|---|---|---|
| HITBOX_SYSTEM_ADMIN | ✅ | ✅ |
| HITBOX_ORDER_MANAGER | ✅ | ✅ |
| HITBOX_FINANCE_ADMIN, HITBOX_SUPPORT | ✅ | ❌ |
| Brand Admin / Employee | as for the order list today | ❌ |
| Buyers | ❌ | ❌ |

Organization scoping is the same as the order list: an order outside the
caller's organizations is a `404`, indistinguishable from one that doesn't
exist.

---

## 13. Errors

| Status | Code | When |
|---|---|---|
| `400` | `ORDERS_WRONG_ITEM` | Scanned unit is a different drop or variant |
| `400` | `ORDERS_UNIT_UNAVAILABLE` | Archived, inactive, claimed, blocked, untagged, or tag not `BOUND` |
| `400` | `ORDERS_NOT_ASSIGNABLE` | Order isn't `PAID`/`PROCESSING`, or holds no stock |
| `400` | `ORDERS_UNIT_NOT_ASSIGNED` | Trying to ship before scanning |
| `404` | `ORDERS_NOT_FOUND` | Order missing or outside your organizations |
| `404` | `ORDERS_UNIT_NOT_FOUND` | Nothing matches the scan |
| `404` | `ORDERS_NO_WAITING_ORDER` | Scan-first: no order waiting for that variant |
| `409` | `ORDERS_UNIT_UNAVAILABLE` | Unit already sold or held for another order |
| `409` | `ORDERS_UNIT_ALREADY_ASSIGNED` | Order already has a different unit; send `replace: true` |
| `409` | `ORDERS_ASSIGN_CONFLICT` | Another packer changed the order/unit at the same moment — scan again |
| `422` | `VALIDATION_ERROR` | Not exactly one of `tagId` / `skuCode` / `serialNumber`, or a malformed field |

---

## 14. Setup

One additive migration, `20261014100000_order_unit_assignment` — two nullable
columns on `Order`: `unitAssignedAt`, `unitAssignedById`. From
`packages/shared/database`:

```bash
pnpm db:deploy
```

No backfill: existing orders read as "not yet scanned".

---

## 15. Where the code lives

```
packages/orders/src/
  dto/order-fulfilment.dto.ts                ← request schemas + packing-state shape
  repository/order-fulfilment.repository.ts  ← the queue, unit lookup, and the transactional swap
  service/order-fulfilment.service.ts        ← the rules: right item, shippable, replace, scan-first
  controller/order-fulfilment.controller.ts
  module.ts                                  ← routes under /admin/orders
  service/order.service.ts                   ← ship gate + allowedTransitions
packages/orders/prisma/orders.prisma         ← Order.unitAssignedAt / unitAssignedById
packages/orders/tests/order-fulfilment.test.ts
```

---

## 16. Packing-screen checklist

- [ ] Show the queue (`/fulfilment-queue`), optionally filtered to the variant at the packer's bin.
- [ ] On an order: show `variantLabel` large ("PICK: S / Red"); don't show the placeholder serial as something to find.
- [ ] Accept NFC tap (`tagId`) and barcode (`skuCode`); send whichever was scanned.
- [ ] On `ORDERS_WRONG_ITEM`, show expected vs scanned clearly.
- [ ] After success, print the packing slip with the **assigned** `skuCode` / serial.
- [ ] Offer "replace item" (sends `replace: true`) only on an already-assigned order.
- [ ] Enable "Ship" only when `readyToShip` / `allowedTransitions` includes `SHIPPED`.
