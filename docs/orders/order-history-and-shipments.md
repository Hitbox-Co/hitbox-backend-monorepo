# Order history, audit and shipment tracking

Every order now has a complete **timeline** of the statuses it went through,
admin actions are **audited**, and shipping records a **carrier and tracking
number** that the buyer can see. There is no logistics partner integration:
HitBox ships with whichever carrier suits the parcel and types in what the
carrier gave it.

Related: [order-unit-assignment-api.md](order-unit-assignment-api.md) (packing) ·
[checkout-sweep.md](checkout-sweep.md) (unpaid orders) ·
[order-payments-and-refunds-api.md](order-payments-and-refunds-api.md) ·
[admin/admin-write-apis.md](../admin/admin-write-apis.md)

All paths are under **`/api/v1`** and need a Clerk session.

---

## 1. The flow

```
PENDING_PAYMENT ─(payment webhook)─▶ PAID ─(scan unit)─▶ PROCESSING
     ─(record shipment: carrier + tracking no.)─▶ SHIPPED
     ─(admin confirms, or buyer taps NFC tag)─▶ DELIVERED
```

| Step | Who / what | Endpoint |
|---|---|---|
| Pack | Packer scans the unit | `POST /admin/orders/:orderId/unit` |
| **Ship** | Operator records the carrier and tracking number | **`POST /admin/orders/:orderId/shipment`** |
| Fix a typo | Operator corrects the tracking | `PUT /admin/orders/:orderId/shipment` |
| **Deliver** | Operator, after checking the carrier's tracking page | `PATCH /admin/orders/:orderId/status { "status": "DELIVERED" }` |
| **Deliver** (automatic) | Buyer taps the item's NFC tag | — (claim event) |
| Track | Buyer | **`GET /orders/:orderId/tracking`** |

**Shipping only happens by recording the shipment.**
`PATCH …/status { "status": "SHIPPED" }` is refused with
`ORDERS_SHIPMENT_REQUIRED`, so an order can never be SHIPPED without a tracking
number for the buyer.

---

## 2. Ship: `POST /admin/orders/:orderId/shipment`

🔒 `order:manage` (organization-scoped staff may ship their organization's orders).

```json
{
  "carrierName": "Delhivery",
  "trackingNumber": "1490 0000 0012 3",
  "trackingUrl": "https://www.carrier-site.example/track/14900000000123",
  "note": "Fragile — packed with extra foam"
}
```

| Field | Rules |
|---|---|
| `carrierName` | Required, 2–60 chars, free text: whatever carrier you used ("UPS", "Royal Mail", "Blue Dart") |
| `trackingNumber` | Required. **Spaces are removed** (`"1Z 999 AA1"` → `"1Z999AA1"`). Then 4–40 letters, digits or dashes |
| `trackingUrl` | Optional. The carrier's tracking link for this parcel, copied from the carrier. **Must start with `https://`** (it is shown to the buyer) |
| `note` | Optional, internal, **never shown to the buyer** |
| `allowDuplicate` | Optional, default `false`. See below |

Requirements: the order is `PROCESSING` and its unit has been scanned
(`unitAssignedAt` set). In **one transaction** the backend:

- creates the shipment (`ACTIVE`);
- moves the order `PROCESSING → SHIPPED` and stamps `shippedAt`;
- sets the legacy `trackingNote` to `"<carrier> <number>"` for older screens;
- writes the history row (source `SHIPMENT`);

then writes an audit entry (`order.shipment.record`) and publishes
`orders.order.status-changed` and `orders.order.shipment-recorded` (what a
"your order has shipped" email will hang off).

→ `201 { "data": OrderDetail }` (the refreshed order, see §6).

**Duplicate protection.** If the same carrier and tracking number (ignoring
case) is already on another order's live shipment, you get
`409 ORDERS_TRACKING_IN_USE` with `details.orderId`. That's almost always a paste
from the wrong row. If it really is one parcel for two orders, resend with
`"allowDuplicate": true`.

Two operators pressing Ship at once: the order row is locked, so one ships and
the other gets an error. You can't end up with two shipments.

---

## 3. Correct tracking: `PUT /admin/orders/:orderId/shipment`

🔒 `order:manage`. Same body as §2 plus a required **`reason`** (3–500 chars).
Allowed while the order is `SHIPPED`.

```json
{ "carrierName": "Delhivery", "trackingNumber": "14900000000124", "reason": "Last digit was mistyped" }
```

The current shipment is **voided** (`status: VOIDED`, `voidedAt`, `voidedById`,
`voidReason`) and a new `ACTIVE` one takes its place. Nothing is overwritten, so
"which number did the buyer see on Tuesday?" stays answerable. Audited with the
old and new numbers. Not a status change, so no history row.
→ `200 { "data": OrderDetail }`.

---

## 4. Delivery: there is no carrier feed

Two ways an order becomes `DELIVERED`:

| How | `history.source` | `shipment.deliveredVia` |
|---|---|---|
| An operator checks the carrier's tracking page and marks it delivered: `PATCH /admin/orders/:orderId/status { "status": "DELIVERED", "reason": "Carrier shows delivered 21 Oct" }` | `ADMIN` | `ADMIN` |
| **The buyer taps the item's NFC tag** (first claim). Only a buyer holding the item can do that, so it's the strongest proof of delivery there is. Happens automatically | `NFC_CLAIM` | `NFC_CLAIM` |

The NFC rule applies only to a `SHIPPED` order. A tap on an already-delivered
order, or a second tap, changes nothing. `deliveredAt` is the moment of the tap.

---

## 5. Buyer: `GET /orders/:orderId/tracking`

> All buyer-facing order APIs (my orders, detail, cancel, resume payment,
> refunds, invoices) are documented together in
> [buyer-orders-api.md](buyer-orders-api.md).

🔒 any `order:read` (buyers have `order:read:own`). Returns the order **only
to its buyer**; anyone else gets `404`.

```json
{
  "data": {
    "orderId": "8c1e…",
    "status": "SHIPPED",
    "placedAt": "2026-10-20T09:00:00.000Z",
    "paidAt": "2026-10-20T09:01:00.000Z",
    "shippedAt": "2026-10-21T15:20:00.000Z",
    "deliveredAt": null,
    "shipment": {
      "carrierName": "Delhivery",
      "trackingNumber": "14900000000123",
      "trackingUrl": "https://www.carrier-site.example/track/14900000000123",
      "shippedAt": "2026-10-21T15:20:00.000Z",
      "deliveredAt": null,
      "deliveredVia": null
    },
    "timeline": [
      { "status": "PENDING_PAYMENT", "at": "2026-10-20T09:00:00.000Z" },
      { "status": "PAID",            "at": "2026-10-20T09:01:00.000Z" },
      { "status": "PROCESSING",      "at": "2026-10-21T11:02:00.000Z" },
      { "status": "SHIPPED",         "at": "2026-10-21T15:20:00.000Z" }
    ]
  }
}
```

`shipment` is `null` until the order ships. Internal notes, staff ids and voided
(corrected) tracking numbers are never included.

**Frontend:** show the carrier and number with a copy button. If
`trackingUrl` is set, show a **Track parcel** button that opens it. If not, tell
the buyer to enter the number on the carrier's website.

---

## 6. Order detail additions (admin)

`GET /admin/orders/:orderId` (and the response of every admin write) now includes:

| Field | Meaning |
|---|---|
| `history[]` | The timeline, oldest first: `{ id, fromStatus, toStatus, source, actorId, reason, metadata, occurredAt }` |
| `shipment` | The live shipment, or `null` |
| `shipments[]` | Every shipment, newest first, including `VOIDED` corrections |
| `canRecordShipment` | `PROCESSING` + unit scanned + no shipment yet → show **Ship (add tracking)** |
| `canCorrectShipment` | `SHIPPED` with a shipment → show **Correct tracking** |
| `allowedTransitions` | No longer ever contains `SHIPPED` (use `canRecordShipment`) |
| `paidAt` | Now filled in when payment settles (it used to stay null) |

Shipment object:
`{ id, carrierName, trackingNumber, trackingUrl, note, status, createdById, createdAt, deliveredAt, deliveredVia, voidedAt, voidedById, voidReason }`.

### `history[].source`

| Source | Written when |
|---|---|
| `CHECKOUT` | Order placed (`actorId` = buyer) |
| `PAYMENT` | Payment settled (→ PAID) or failed (→ CANCELLED) |
| `PACKING` | Unit scanned (PAID → PROCESSING); `metadata.skuId` |
| `SHIPMENT` | Shipment recorded (→ SHIPPED); `metadata.shipmentId`, `carrierName`, `trackingNumber` |
| `ADMIN` | An operator changed the status (`actorId`, `reason`) |
| `NFC_CLAIM` | Buyer tapped the tag (→ DELIVERED); `metadata.claimId` |
| `REFUND` | Refund processed (→ REFUNDED); `metadata.refundRequestId`, `actorId` = processor |
| `CHECKOUT_SWEEP` | Unpaid order cancelled by the sweep |
| `BACKFILL` | One row per order that existed before history was introduced: its status at that moment. Earlier steps weren't recorded and aren't invented |

**History can't drift from the order.** Every row is written in the same
transaction as the status change, so a change and its history row commit or
roll back together. Rows are never updated or deleted.

---

## 7. Audit log

Who did what to an order is also written to the platform audit log (the
`AuditEvent` table, with `resourceType: "Order"` and `resourceId` set to the
order id):

| Event | Severity | Recorded when |
|---|---|---|
| `order.status.change` | WARNING | An operator changes an order's status (processing, delivered, cancel) |
| `order.shipment.record` | WARNING | An operator records or corrects tracking (before/after numbers, reason) |

The actor is `HITBOX_EMPLOYEE` for platform staff and `BRAND_EMPLOYEE` for
organization-scoped staff. System changes (payment webhook, sweep, NFC tap,
refund pipeline) are on the order's own history (§6). The refund pipeline also
has its own audit events.

These event types must exist in the database. `pnpm db:seed:audit` adds them,
and must run on every deploy.

---

## 8. Errors

| Status | Code | When |
|---|---|---|
| `400` | `ORDERS_SHIPMENT_REQUIRED` | `PATCH …/status` with `SHIPPED`. Record the shipment instead |
| `400` | `ORDERS_UNIT_NOT_ASSIGNED` | Shipping before the unit was scanned |
| `400` | `ORDERS_NOT_SHIPPABLE` | Shipping an order that isn't `PROCESSING`, or correcting one that isn't `SHIPPED` / has no shipment |
| `409` | `ORDERS_SHIPMENT_EXISTS` | A shipment is already recorded. Use `PUT` to correct it |
| `409` | `ORDERS_TRACKING_IN_USE` | Same carrier + number on another order (`details.orderId`). Check it, or send `allowDuplicate: true` |
| `404` | `ORDERS_NOT_FOUND` | Order missing, outside your organizations, or (buyer) not yours |
| `422` | `VALIDATION_ERROR` | Bad tracking number format, non-https link, missing `reason` on a correction |

---

## 9. Frontend checklist

**Admin order page**
- [ ] **Ship (add tracking)** when `canRecordShipment`: form with carrier (free text, with suggestions of carriers you use), tracking number, optional tracking link, optional internal note. On `ORDERS_TRACKING_IN_USE`, show "Already on order {details.orderId}", with a "Ship anyway" option that resends with `allowDuplicate: true`.
- [ ] Shipment card: carrier, number (copy button), link, shipped date, delivered date and how (`deliveredVia`: "Confirmed by staff" or "Buyer tapped the tag").
- [ ] **Correct tracking** when `canCorrectShipment`: same form plus a required reason. Show voided shipments struck through under "Previous tracking".
- [ ] **Mark delivered** (from `allowedTransitions`) with a reason field, e.g. "Carrier shows delivered on 21 Oct".
- [ ] Timeline from `history[]`: status, source label, who (`actorId` resolved to a name) and reason. Render `BACKFILL` rows as "Earlier history not recorded".
- [ ] Remove the old "Mark shipped" status button. `allowedTransitions` no longer offers it.

**Buyer order page**
- [ ] Call `GET /orders/:orderId/tracking`. Show the timeline as a stepper, and the carrier, number and Track parcel button once `shipment` isn't null.
- [ ] When delivered via `NFC_CLAIM`, say "Delivered: you tapped your item".

---

## 10. Where the code lives

```
packages/orders/prisma/orders.prisma               ← OrderStatusHistory, OrderShipment (+ enums)
packages/shared/database/prisma/migrations/20261022100000_order_history_and_shipments/
packages/orders/src/
  repository/order-history.ts                      ← recordStatusChange(tx, …) — the one writer
  repository/order-shipment.repository.ts          ← record / replace under an order-row lock, buyer view
  repository/order-write.repository.ts             ← history on checkout, payment, cancel, refund; deliverOnClaim
  repository/order.repository.ts                   ← admin status change + history (+ shipment delivered)
  repository/order-fulfilment.repository.ts        ← history on PAID → PROCESSING
  service/order-shipment.service.ts                ← ship, correct, buyer tracking, audit
  service/order.service.ts                         ← SHIPPED refused, admin changes audited, detail fields
  controller/order-shipment.controller.ts
  domain/interfaces/audit-recorder.port.ts         ← orders' audit port
  module.ts                                        ← routes, buyer router, NFC-claim → delivered
packages/audit/src/domain/audit-event-catalog.ts   ← order.status.change, order.shipment.record
packages/orders/tests/order-shipment.test.ts
apps/backend/src/routes.ts                         ← /orders (buyer)
```
