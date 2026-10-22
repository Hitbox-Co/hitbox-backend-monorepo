# Checkout sweep, cancelling and stock safety

How an order's stock hold is kept honest from checkout to payment, and what
happens when a buyer never pays, pays late, or an order is cancelled or
refunded before it ships.

Related: [order-payments-and-refunds-api.md](order-payments-and-refunds-api.md) ·
[order-unit-assignment-api.md](order-unit-assignment-api.md) ·
[admin/admin-write-apis.md](../admin/admin-write-apis.md) ·
[finance/payments-and-webhooks.md](../finance/payments-and-webhooks.md)

---

## 1. Timeline of an unpaid checkout

```
checkout            hold expires                 grace ends
   │  HELD (15 min)      │   unit back on sale       │  order CANCELLED
   ├─────────────────────┼───────────────────────────┤
   0                  +15 min                     +45 min
                          late payment here: settles if nobody took the unit
```

| Setting | Default | Meaning |
|---|---|---|
| `INVENTORY_HOLD_SECONDS` | `900` | How long checkout holds the unit |
| `UNPAID_ORDER_GRACE_SECONDS` | `1800` | How long the unpaid order is kept after the hold expires, for a late card payment (slow 3-D Secure) |
| `CHECKOUT_SWEEP_INTERVAL_SECONDS` | `60` | How often the server runs the sweep. `0` = off (use the cron script instead) |

---

## 2. The sweep (the "cron")

Every `CHECKOUT_SWEEP_INTERVAL_SECONDS` the API server runs two steps:

1. **Release expired holds.** Every `HELD` reservation past `expiresAt`
   becomes `RELEASED`, and the unit is back on sale straight away.
2. **Cancel unpaid orders.** Every `PENDING_PAYMENT` order whose hold expired
   more than `UNPAID_ORDER_GRACE_SECONDS` ago becomes `CANCELLED`. Its hold is
   released and an `orders.order.status-changed` event is published with
   `actorId: null` and reason "Checkout expired without payment". An order
   with a `COMMITTED` hold (its payment went through) is never touched.

It processes up to 2,000 orders per run (200 at a time); anything left is
picked up on the next tick. It logs `checkout sweep` with
`{ releasedHolds, cancelledOrders }` only when it changed something.

**Safe anywhere, any number of times.** Every write is guarded (an order is
cancelled only `WHERE status = 'PENDING_PAYMENT'`), so several API instances
sweeping at once simply share the work, and a payment that settles at the same
instant wins.

### Running it from an external cron instead

On a platform where you'd rather schedule it yourself (or run many API
instances and want one sweeper), set `CHECKOUT_SWEEP_INTERVAL_SECONDS=0` and
schedule:

```bash
pnpm jobs:checkout-sweep
```

It runs one sweep, prints
`released N expired hold(s), cancelled M unpaid order(s)`, and exits with code
1 on failure so the scheduler can alert. Example crontab (every minute):

```
* * * * *  cd /app && pnpm jobs:checkout-sweep
```

---

## 3. Late payments

A card payment can settle after the hold expired. Settlement
(`OrderWriteRepository.markPaid`) now does this:

| Situation | Result |
|---|---|
| Order still `PENDING_PAYMENT`, unit not taken by anyone else (even if the sweep already released the hold) | **Settles.** Hold re-committed, order `PAID` |
| Another order holds, committed or owns the unit | **Refused.** Our stale hold is released, the order stays `PENDING_PAYMENT` (the sweep cancels it later), and the payment is parked `needsReview` for an admin to refund |
| Order already `CANCELLED` (by an admin or the sweep) | **Refused**, and **nothing is committed** |

Refused payments appear in **Payments → Needs review**
(`GET /admin/payments/transactions?needsReview=true`) with the reason
"Payment settled but the order could not be marked paid".

### Why the same unit can't be sold twice

Checkout, settlement and the packing swap all **lock the unit's row**
(`SELECT … FOR UPDATE`) before deciding who owns it. Two of them working on
the same unit run one after the other, and the second sees the first's
result. Different units never wait on each other.

---

## 4. Cancelling an order (admin)

`PATCH /admin/orders/:orderId/status { "status": "CANCELLED", "reason": "…" }`

| Order status | Result |
|---|---|
| `PENDING_PAYMENT` | Cancelled; **its hold is released immediately**, so the unit is back on sale |
| `PAID`, `PROCESSING` | **`400 ORDERS_CANCEL_REQUIRES_REFUND`.** The buyer has paid, so cancelling means paying them back. Use the refund flow (below) |
| `SHIPPED`, `DELIVERED` | `400 ORDERS_INVALID_TRANSITION`. Use a refund with a return |

`CANCELLED` no longer appears in `allowedTransitions` for `PAID` /
`PROCESSING`, so the UI should show **"Cancel & refund"** there and start a
refund instead of calling this endpoint.

### Cancelling a paid order = refunding it

```http
POST /api/v1/refunds
{ "orderId": "…", "reasonCode": "BUYER_CHANGED_MIND", "reason": "Cancelled before packing",
  "physicalReturnRequired": false }
```

then approve → process as usual
([order-payments-and-refunds-api.md](order-payments-and-refunds-api.md)).
When it's processed:

- the buyer gets the money back;
- the order becomes `REFUNDED`;
- **because it never shipped, the unit goes straight back on sale.** The hold
  is released and the order's `skuId` is cleared (checkout treats any order
  pointing at a unit as a sale). The released reservation row still records
  which unit it was, so the order page shows it as `RELEASED`.

A refund of an order that **did** ship keeps the unit off sale, as before:
whether it can be resold is decided from the returned tag's condition.

---

## 5. Errors

| Code | Status | When |
|---|---|---|
| `ORDERS_CANCEL_REQUIRES_REFUND` | 400 | Cancelling a `PAID` / `PROCESSING` order. Refund it instead |
| `ORDERS_INVALID_TRANSITION` | 409 | Cancelling an unpaid order whose payment settled at that moment. Reload |

---

## 6. Where the code lives

```
packages/orders/src/
  repository/sku-lock.ts               ← lockSku() + unitTakenByAnotherOrder()
  repository/order-write.repository.ts ← markPaid (late payments), markRefunded (frees unshipped units),
                                         cancelUnpaid, findExpiredUnpaid, releaseExpiredReservations
  repository/order-fulfilment.repository.ts ← packing swap takes the same lock
  service/checkout-sweep.service.ts    ← the sweep
  service/order.service.ts             ← CANCELLED rules
  domain/order-status.ts               ← PAID / PROCESSING no longer → CANCELLED
packages/orders/tests/order-cancel-and-sweep.test.ts

apps/backend/src/server.ts             ← the in-process timer
apps/backend/scripts/checkout-sweep.ts ← pnpm jobs:checkout-sweep
packages/shared/config/env.ts          ← UNPAID_ORDER_GRACE_SECONDS, CHECKOUT_SWEEP_INTERVAL_SECONDS
```
