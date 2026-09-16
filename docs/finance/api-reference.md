# API reference — finance & payments

Every endpoint added, **grouped by who calls it**: buyer, artist, admin, and
the payment provider itself.

All paths are relative to `/api/v1` except the webhook, which is mounted at the
server root.

**Conventions.** Every monetary value is a **string** with two decimal places,
in and out — a royalty of 11.25 sent as a JSON number is a float by the time it
reaches the client, and two of them added together give 22.499999999999996.
Errors use the platform envelope:

```json
{ "error": { "code": "FINANCE_NOT_FOUND", "message": "…", "details": null } }
```

Lists return `{ page, limit, total, items }`. Single resources return
`{ data: … }`.

**Capabilities** are resource:action pairs from the permission catalog. Where a
row says "scope narrows rows", the caller's grant scope (`own` / `organization`
/ `global`) filters what comes back — there is no query parameter that widens
it. See [rbac-and-audit.md](rbac-and-audit.md).

---

## Who can call what

The personas below are the platform's built-in roles
(`packages/access-control/src/domain/role-catalog.ts`). A route is reachable
only if the caller holds the capability; what comes *back* is then narrowed by
the **scope** of that grant, which is why the same path appears in more than one
column with different meanings.

| Endpoint | Buyer | Artist | Brand Admin | Finance Admin | Order Manager | System Admin |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `POST /checkout` | ✅ | — | — | — | — | — |
| `POST /refunds` | ✅ own order | — | — | — | — | ✅ any |
| `GET /admin/finance/balances` | — | ✅ own | ✅ org | ✅ all | — | ✅ all |
| `GET /admin/finance/royalty-entries` | — | ✅ own | ✅ org | ✅ all | — | ✅ all |
| `GET /admin/finance/payouts` | — | ✅ own | ✅ org | ✅ all | — | ✅ all |
| `GET /admin/finance/royalty-rules` | — | ◐ | ✅ org | ✅ all | — | ✅ all |
| `GET /admin/finance/ledger`, `/revenue-summary`, `/adjustments` | — | ∅ | ✅ org | ✅ all | — | ✅ all |
| `POST` anything under `/admin/finance` | — | — | — | — | — | ✅ |
| `GET /admin/payments/transactions`, `/refunds` | — | ◐ own purchases | ✅ org | ✅ all | ✖︎ | ✅ all |
| `GET /admin/payments/disputes` | — | ∅ | ∅ | ✅ all | ✖︎ | ✅ all |
| Refund workflow actions (`confirm-return`, `approve`, `reject`, `process`) | — | — | — | — | ✖︎ | ✅ |
| Dispute actions, payment review | — | — | — | — | — | ✅ |
| `/admin/payments/gateway-configs` | — | — | — | — | — | ✅ |
| `POST /webhooks/payments/stripe` | machine-to-machine — no session, signature-verified | | | | | |

**✅** reachable · **◐** reachable but narrower than it looks — see the note
under that persona · **∅** reachable, returns an empty list by construction ·
**✖︎** holds the action capability but is blocked — see
[Two rough edges](#two-rough-edges) · **—** 403.

---

# Buyer

*Role: `BUYER_COLLECTOR`. Holds `order:create:own` and `order:read:own`, and
**no `payment-royalty` grant at all**.*

Two endpoints. Everything else in this document returns 403 for a buyer,
including reading their own refund's status — see
[Two rough edges](#two-rough-edges).

### `POST /checkout`
`order:create` · creates an order, holds a unit, opens a charge attempt.

```jsonc
// request
{
  "productId": "uuid",
  "variantId": "uuid",        // optional
  "marketId": "uuid",         // optional; falls back to the product's active price
  "quantity": 1,              // capped at 1 — every unit is serialized
  "termsAccepted": true,      // must be literally true
  "shippingAddressId": "uuid",// optional, snapshotted onto the order
  "billingAddressId": "uuid", // optional
  "gateway": "STRIPE"
}
```

```jsonc
// 201
{ "data": {
  "orderId": "…", "paymentTransactionId": "…", "skuId": "…",
  "reservationId": "…", "reservationExpiresAt": "2026-09-16T12:15:00.000Z",
  "amount": "100.00", "currency": "USD", "gateway": "STRIPE",
  "status": "INITIATED",
  "clientToken": null,        // null with no gateway adapter wired
  "gatewayRef": null
}}
```

Errors: `PAYMENTS_NOT_PURCHASABLE` (drop not on sale / not open / closed),
`PAYMENTS_OUT_OF_STOCK`, `PAYMENTS_NO_PRICE`, `PAYMENTS_NO_GATEWAY`.

### `POST /refunds`
Authenticated, **no capability required** — the service checks that the caller
owns the order. Raising one on *someone else's* order needs
`order:refund:global`, which is the support/admin path onto the same endpoint.

```jsonc
{ "orderId": "uuid", "reasonCode": "DEFECTIVE_TAG", "reason": "NFC tag not responding",
  "amount": "100.00",             // optional, defaults to the order total
  "physicalReturnRequired": true } // false for digital-only
```

Returns the refund with `allowedTransitions`, so a UI enables exactly the
buttons that will work.

### What a buyer cannot do

Nothing else here. In particular a buyer cannot approve, reject or execute their
own refund — the whole workflow after "requested" is an operator's, which is the
source document's requirement (*"Only HitBox Admins see refund workflow"*).

---

# Artist

*Role: `ARTIST`. Holds `payment-royalty:read:own`, which resolves to **OWN**
scope — every finance read is filtered to the artist profile linked to their
user account.*

An artist has **read-only** access to their own earnings. There is no endpoint
in this module an artist can write to.

### `GET /admin/finance/balances`
What they have earned, are owed, and have been paid, per currency — and whether
they have reached their payout threshold. This is the artist's earnings screen.

```jsonc
{ "data": [{
  "payeeType": "ARTIST", "payeeId": "…", "currency": "USD",
  "accrued": "506.25", "pendingPayout": "0.00", "paid": "1200.00",
  "reversed": "11.25", "outstanding": "506.25", "entryCount": 45,
  "threshold": "500.00", "thresholdMet": true
}]}
```

### `GET /admin/finance/royalty-entries`
Every accrual, with the arithmetic that produced it. Filters: `status`,
`entryType`, `currency`, `orderId`, `payoutId`, `from`, `to`.

Passing `?artistId=` belonging to someone else returns an empty page — the
filter is applied *on top of* the scope clause, never in place of it.

### `GET /admin/finance/royalty-entries/:entryId`
One entry plus every adjustment posted against it — the traceability view:

```jsonc
{ "data": {
  "id": "…", "orderId": "…", "claimId": "…", "skuId": "…",
  "payee": { "type": "ARTIST", "artistId": "…", "name": "LeBron James" },
  "calculation": { "basis": "NET_PROFIT", "percentage": "15",
                   "grossRevenue": "100.00", "costOfGoods": "25.00",
                   "netProfit": "75.00" },
  "amount": "11.25", "currency": "USD",
  "entryType": "ORIGINAL", "status": "ACCRUED",
  "accruedAt": "2026-09-06T15:15:00.000Z", "paidAt": null,
  "adjustments": [ … ]
}}
```

### `GET /admin/finance/payouts` · `GET /admin/finance/payouts/:payoutId`
Their own payout batches: amount, `entryCount`, status, `paidAt`, and the
provider's payout reference.

### Endpoints an artist can reach, but that will not show what they expect

Three things are worth knowing rather than discovering:

**`/royalty-rules` (◐).** Rule listing filters by the caller's *organization*
ids, not by artist. An artist sees rules carrying their organization's id; a
rule scoped to the artist alone (`organizationId` null) is not listed — even
though it is the rule pricing their royalties. The entry detail above is the
reliable way for an artist to see the terms that were applied, because it
carries `basis` and `percentage` on the row itself.

**`/ledger`, `/revenue-summary`, `/adjustments` (∅).** These are HitBox's own
books — gateway fees, chargebacks, platform margin. There is no per-artist slice
of them that would mean anything, so OWN scope matches nothing and the response
is an empty list rather than a 403.

**`/admin/payments/transactions` and `/admin/payments/refunds` (◐).** An artist
holds `payment-royalty:read`, so these routes admit them — but the payments
scope filter for OWN is `order.buyerId = caller`, so what comes back is **their
own purchases as a customer**, not the sales of their drops. Disputes return
nothing at all.

---

# Admin

Four distinct operator personas, and they are genuinely different: the catalog
separates *reading* money from *administering* it from *refunding* it, and this
API honours that rather than collapsing it into one "admin" flag.

## Brand Admin

*Role: `BRAND_ADMIN`. Holds `payment-royalty:read:organization` → **ORGANIZATION**
scope.*

Read-only, confined to their own organization — **plus the artists that
organization manages** (via `Artist.organizationId`), which is what makes a
brand dashboard possible. It cannot see an artist it does not manage.

Reachable: `/admin/finance/balances`, `/royalty-entries`, `/royalty-entries/:id`,
`/payouts`, `/payouts/:id`, `/royalty-rules`, `/ledger`, `/revenue-summary`,
`/adjustments`, and `/admin/payments/transactions`, `/refunds` — all narrowed to
the organization's orders. Disputes return nothing (platform matter).

Writes: none.

> `BRAND_EMPLOYEE` holds no `payment-royalty` grant at all and gets 403 on every
> endpoint in this document. That is deliberate in the role catalog: royalties
> owed are hidden from that role.

## HitBox Finance Admin

*Role: `HITBOX_FINANCE_ADMIN`. Holds `payment-royalty:read:global` and
`order:read:global`.*

**Reads everything, writes nothing.** Every `GET` in this document, unfiltered.
No payout may be scheduled, approved or executed by this role, no adjustment
posted, no refund approved, no gateway configured — `payment-royalty:manage`
and `:configure` are System-Admin-only in the catalog, and the services
re-check that rather than trusting the route guard.

If you want a finance operator who can actually run the payout cycle, that is a
role-catalog change (granting `payment-royalty:manage:global`), not a code
change here.

## HitBox Order Manager

*Role: `HITBOX_ORDER_MANAGER`. Holds `order:refund:global` and
`order:manage:global`, and no `payment-royalty` grant.*

In principle this is the refund persona. In practice it is currently blocked on
every refund endpoint — see [Two rough edges](#two-rough-edges).

## HitBox System Admin

*Role: `HITBOX_SYSTEM_ADMIN`. Holds `payment-royalty:manage|configure|override:global`
and `order:refund:global`.*

The only built-in role that can write anything below.

### Royalty rules — `/admin/finance/royalty-rules`

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/royalty-rules` | `payment-royalty:read` (scope narrows rows) |
| `POST` | `/royalty-rules` | `payment-royalty:manage:global` |
| `GET` | `/royalty-rules/:ruleId` | `payment-royalty:read` |
| `POST` | `/royalty-rules/:ruleId/close` | `payment-royalty:manage:global` |

**There is no PUT, PATCH or DELETE, and that is the design.** A rule that has
priced an accrual cannot change its terms retroactively without making every
entry posted under it unexplainable. A renegotiation is *close the old rule,
create the successor*.

```jsonc
// POST /royalty-rules
{ "artistId": "uuid",            // or collectionId / productId / organizationId
  "basis": "NET_PROFIT",         // or GROSS_REVENUE
  "percentage": "15",            // 15 means 15%
  "splits": [                    // …or a multi-party deal instead
    { "payeeType": "ARTIST", "artistId": "uuid", "percentage": "10" },
    { "payeeType": "ORGANIZATION", "organizationId": "uuid", "percentage": "5" }
  ],
  "payoutThreshold": "500.00",
  "payoutFrequency": "MONTHLY",
  "effectiveFrom": "2026-09-16T00:00:00Z" }

// POST /royalty-rules/:ruleId/close
{ "effectiveTo": "2027-01-01T00:00:00Z", "reason": "renegotiated" }
```

Splits totalling more than 100% are refused: the cost of that typo is money paid
out that the platform never took in.

### Reversing a posting

`POST /admin/finance/royalty-entries/:entryId/reverse` ·
route takes `payment-royalty:manage:global`, and the controller then requires
**`payment-royalty:override:global`** on top. Cancelling an accrual the
calculation says is owed is a different power from running the calculation.

```jsonc
{ "reasonCode": "CALCULATION_ERROR", "reason": "COGS was recorded twice" }
```

It reverses **that one entry**, not the order's — so a mis-calculated split on a
three-way deal can be fixed without cancelling the other two payees' earnings.

### Payouts — `/admin/finance/payouts`

| Method | Path | Capability |
| --- | --- | --- |
| `POST` | `/payouts/schedule` | `payment-royalty:manage:global` |
| `POST` | `/payouts/:payoutId/approve` | `payment-royalty:manage:global` |
| `POST` | `/payouts/:payoutId/execute` | `payment-royalty:manage:global` |
| `POST` | `/payouts/:payoutId/fail` | `payment-royalty:manage:global` |

```jsonc
// POST /payouts/schedule — with no body, sweeps every payee at their own threshold
{ "artistId": "uuid", "currency": "USD",
  "thresholdOverride": "100.00",  // explicit, never a default
  "dryRun": true }                // preview without writing

// → { "data": { "scheduled": [ … ], "skipped": [ { "payeeId", "reason" } ] } }

// POST /payouts/:id/execute
{ "gatewayPayoutRef": "po_1abc…", "paidAt": "2026-11-05T…" }

// POST /payouts/:id/fail
{ "failureReason": "bank account rejected the transfer" }
```

Three separate calls because they are three separate acts with different actors
and different failure modes. `fail` releases the entries back to `ACCRUED` so
the next sweep picks them up — a failed payout must not strand an artist's
earnings in a state no job looks at.

### Adjustments and the platform ledger

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/adjustments` | `payment-royalty:read` |
| `POST` | `/adjustments` | `payment-royalty:manage:global` |
| `GET` | `/ledger` | `payment-royalty:read` |
| `GET` | `/revenue-summary` | `payment-royalty:read` |

```jsonc
// POST /adjustments — signed: negative reverses, positive posts a make-good
{ "targetType": "ROYALTY_LEDGER_ENTRY", "targetId": "uuid", "orderId": "uuid",
  "amountAdjustment": "-11.25", "currency": "USD",
  "reasonCode": "CALCULATION_ERROR", "reason": "COGS was recorded twice" }
```

It writes the adjustment and a matching platform-ledger line, and it does **not**
touch whatever it corrects. That is the immutability principle in one endpoint.

`GET /revenue-summary` returns **one row per currency, never summed across
them** — there is no FX rate in this system, and a "total revenue" that adds
dollars to rupees is worse than no total:

```jsonc
{ "data": [{
  "currency": "USD",
  "grossRevenue": "10000.00", "costOfGoods": "2500.00", "gatewayFees": "290.00",
  "refunds": "100.00", "chargebacks": "0.00", "royaltyExpense": "1125.00",
  "netMargin": "5985.00", "orderCount": 100
}]}
```

### Payment transactions — `/admin/payments/transactions`

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/transactions` | `payment-royalty:read` (scope narrows rows) |
| `GET` | `/transactions/:paymentId` | `payment-royalty:read` |
| `POST` | `/transactions/:paymentId/review` | `payment-royalty:manage:global` |

Filters: `orderId`, `status`, `gateway`, `needsReview`, `currency`, `from`,
`to`, `page`, `limit`.

`review` takes `{ decision: "APPROVE" | "REJECT", note }`. `NEEDS_REVIEW` exists
so a transaction with something wrong about it — settled but unfulfillable,
mismatched amount — stops rather than failing; clearing it is a decision with a
name on it, so the note is required.

### Refund workflow — `/admin/payments/refunds`

| Method | Path | Capability | D4-35 step |
| --- | --- | --- | --- |
| `GET` | `/refunds` | `payment-royalty:read` | — |
| `GET` | `/refunds/:refundId` | `payment-royalty:read` | — |
| `POST` | `/refunds/:refundId/confirm-return` | `order:refund:global` | 2 |
| `POST` | `/refunds/:refundId/approve` | `order:refund:global` | 3 |
| `POST` | `/refunds/:refundId/reject` | `order:refund:global` | — |
| `POST` | `/refunds/:refundId/process` | `order:refund:global` | 4–6 |

```jsonc
// confirm-return
{ "nfcTagCondition": "DAMAGED", "note": "…", "receivedAt": "2026-09-20T…" }

// approve
{ "note": "…", "overridePhysicalReturn": false, "overrideReason": "…" }

// reject
{ "rejectionReason": "…" }

// process
{ "gatewayRefundId": "re_1abc…",  // required when no gateway adapter is wired
  "processedAt": "2026-09-21T…" }
```

`process` returns the refund with `claimRevokedAt` and `resaleBlockedUntil`
filled in. Errors: `PAYMENTS_RETURN_NOT_CONFIRMED`,
`PAYMENTS_INVALID_TRANSITION`, `PAYMENTS_GATEWAY_UNAVAILABLE`,
`PAYMENTS_AMOUNT_EXCEEDS_CAPTURE`.

### Disputes — `/admin/payments/disputes`

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/disputes` | `payment-royalty:read` |
| `POST` | `/disputes` | `payment-royalty:manage:global` |
| `GET` | `/disputes/:disputeId` | `payment-royalty:read` |
| `POST` | `/disputes/:disputeId/evidence` | `payment-royalty:manage:global` |
| `POST` | `/disputes/:disputeId/resolve` | `payment-royalty:manage:global` |

`GET /disputes` takes `status` and `dueBefore`, and is ordered by soonest
evidence deadline — the queue is a countdown.

```jsonc
// resolve
{ "outcome": "LOST", "resolutionNote": "…", "feeAmount": "15.00" }
```

`LOST` / `ACCEPTED` book the chargeback and its fee, mark the order refunded and
reverse the royalty. `WON` changes nothing but the case's own status.

### Gateway configuration — `/admin/payments/gateway-configs`

`payment-royalty:configure:global` — **System Admin only**, and the narrowest
capability in the catalog, because changing `credentialsRef` is functionally
changing the bank account the platform's money lands in.

| Method | Path |
| --- | --- |
| `GET` | `/gateway-configs` |
| `POST` | `/gateway-configs` |
| `PATCH` | `/gateway-configs/:configId` |

```jsonc
{ "scope": "ORGANIZATION", "organizationId": "uuid", "gateway": "STRIPE",
  "isDefault": true, "credentialsRef": "secretsmanager://hitbox/stripe/brand-x",
  "status": "ACTIVE" }
```

`credentialsRef` is a pointer, never a key — a value starting `sk_`, `rk_`,
`pk_live` or `whsec_` is refused with a message saying where it belongs.

### Webhook replay queue

`GET /admin/payments/webhook-events` · `payment-royalty:manage:global` ·
filters `provider`, `eventType`, `unprocessedOnly`.

The stored raw `payload` is **not** returned: it is the provider's JSON, it can
contain cardholder detail, and this screen only needs to know what arrived and
whether it processed.

---

# Machine-to-machine

### `POST /webhooks/payments/stripe`

No session and no persona — the `Stripe-Signature` header is the gate. Mounted
outside `/api/v1` on a 600/min budget. **Not mounted at all without
`STRIPE_WEBHOOK_SECRET`** — a 503 router stands in its place, because an
unverified payment webhook is a way to mark any order paid.

```jsonc
// 200 — a replay is a success from the provider's point of view
{ "received": true, "processed": false, "eventId": "evt_1abc" }
```

400 `PAYMENTS_INVALID_SIGNATURE` when verification fails, with no detail about
why. A 5xx on a processing failure is deliberate: the delivery is already
recorded for replay, and the provider should retry.

---

## Two rough edges

Both are mismatches between the role catalog and the guards on these routes.
Neither is hidden by a workaround in the code, and both are one-line fixes if
you want them — but they are **not** changed here, because they affect who can
touch money and that is your call, not a doc's.

**1. `HITBOX_ORDER_MANAGER` cannot use the refund workflow it was designed for.**
It holds `order:refund:global`, which is what the four refund action routes
require — but every handler first calls `buildPaymentAccess(principal)`, which
throws 403 when the caller holds no `payment-royalty` grant at all. The Order
Manager holds none. So the refund workflow is, today, reachable only by
`HITBOX_SYSTEM_ADMIN` (the one built-in role holding both).

That happens to match the source document — *"Only HitBox Admins see refund
workflow; Artist cannot access"* — so it is defensible as it stands. If you want
Order Manager to work the refund queue, the fix is to add
`payment-royalty:read:global` to that role in the catalog.

**2. A buyer cannot read the status of their own refund.** `RefundService` and
`PaymentService` both have an OWN-scope filter (`order.buyerId = caller`) ready
for exactly this, but the routes are guarded by `payment-royalty:read`, which
`BUYER_COLLECTOR` does not hold. The buyer can raise a refund and then sees
nothing until it resolves.

The fix is either granting `payment-royalty:read:own` to `BUYER_COLLECTOR`
(which would also expose their own payment transactions — probably fine, and
arguably what they should see) or adding an ungated `GET /refunds/:id` to the
buyer router that checks ownership the way `POST /refunds` already does. The
second is narrower and is what I would do.
