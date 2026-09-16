# Payments, checkout and webhooks

How money gets in, and how the platform knows it did.

## The one belief this module is built on

**The authoritative statement that money moved is the webhook, never the
response to the request that started it.** That is how card payments actually
work — a 200 from a charge request means the provider accepted the instruction,
not that funds settled — and treating anything else as authoritative is how a
platform ships an order nobody paid for.

Everything below follows from that, including the decision to make the gateway
adapter optional.

## Checkout

`POST /api/v1/checkout` (capability `order:create`)

```text
placeOrder ──▶ Order PENDING_PAYMENT + InventoryReservation HELD   (one transaction)
resolve   ──▶ PaymentGatewayConfig: DROP > ORGANIZATION > PLATFORM
create    ──▶ PaymentTransaction INITIATED, idempotencyKey = order:<id>:attempt:1
[adapter] ──▶ provider charge → gatewayRef + clientToken, status → PENDING
```

Checkout lives in the **payments** module, not orders. The reason is the
dependency direction: something has to depend on the other, a purchase starts
with money, and orders knows nothing about gateways. Orders implements
payments' `IOrderLedger` port. See [module-boundaries.md](module-boundaries.md).

### Picking a unit

A SKU is available when it is active, unclaimed, not resale-blocked, not already
assigned to an order, and **not held by a live reservation**. That last
condition is the race: two buyers hitting checkout on the last unit of 500 will
both *read* it as free.

The guard is a create-then-verify inside the transaction — insert the
reservation, then count live holds on that unit; if the count is greater than
one, this transaction aborts. Exactly one of the two wins. A `SELECT … FOR
UPDATE` would also work and would serialise every checkout on a hot drop, which
on a timed release is the entire traffic pattern.

Units go out lowest serial first, which is what buyers expect of a numbered
edition.

### Quantity is capped at 1

Deliberately, and enforced in the DTO. Every unit is serialized and an `Order`
carries exactly one `skuId`, so "2 of #14" is not a thing that exists. A real
multi-unit basket needs order lines, which this schema does not have. Refusing
it is honest; silently reserving two units against one order id would not be.

### Regional pricing

`ProductPrice` is per (product, variant, market) and carries `costOfGoods`. A
market the drop has no **active** price row for is not a market it is sold in —
checkout returns `PAYMENTS_NO_PRICE` rather than falling back to another
market's number, which would charge someone in the wrong currency. No FX
conversion happens anywhere in this system, and the revenue summary never sums
across currencies for the same reason.

### Stock holds expire

`InventoryReservation.expiresAt` is `now + INVENTORY_HOLD_SECONDS` (default 900
— long enough for a 3-D Secure challenge, short enough that an abandoned basket
does not keep a one-of-500 unit off sale for an hour).

`bootstrap()` returns `releaseExpiredReservations()` for a scheduler to call. It
is idempotent and safe to run concurrently. **It is not scheduled by this
change** — there is no job runner in this app yet; see
[coverage-matrix.md](coverage-matrix.md). Until one exists, an expired hold is
still correctly *ignored* by the availability query (it filters on
`expiresAt > now`), so the unit is sellable; the sweeper only tidies the row.

## The webhook endpoint

`POST /webhooks/payments/stripe` — unauthenticated, mounted **outside**
`/api/v1`.

Two things about where it is mounted:

* **Outside `/api/v1`** and on its own rate-limit budget (600/min vs 100). Stripe
  bursts retries after an outage, and throttling a settlement webhook to a
  mobile client's budget means orders silently stay unpaid.
* **Not mounted at all without `STRIPE_WEBHOOK_SECRET`.** An unverified payment
  webhook is a way to mark any order paid. Bootstrap substitutes a router that
  returns 503 with a clear message — which is a distinction worth preserving,
  because a 404 looks to the provider, and to whoever is debugging, exactly like
  a misconfigured URL.

### Signature verification

`packages/payments/src/domain/webhook-signature.ts`, implemented directly rather
than pulled from an SDK.

```text
Stripe-Signature: t=1699999999,v1=5257a86…,v1=<older key's signature>
signed_payload   = "{t}.{raw request body}"
expected         = HMAC-SHA256(signed_payload, signing_secret)
```

Three properties, each of which is a real vulnerability when it is missing:

**It hashes the raw bytes.** `JSON.stringify(req.body)` is not the request body
— key order, whitespace and unicode escaping all differ — so a re-serialised
payload never matches, and the usual "fix" for that is to stop verifying.
`app.ts` captures `req.rawBody` in `express.json({ verify })` for exactly this.

**It compares in constant time.** `===` on a hex digest leaks, through timing,
how many leading characters an attacker guessed right, which turns forging a
signature into a few thousand requests.

**It enforces a timestamp window** (`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`, default
300), in both directions. Without it a delivery captured once is replayable
forever, signature and all. The idempotency table stops the *same* event being
processed twice; this is what stops an old, valid, captured event being fed back
in at a chosen moment.

An unverified delivery is rejected **before anything is written** and the
response says only that verification failed — naming the reason would tell
whoever is probing exactly which part of the forgery to fix.

### Idempotency, three layers

The design document asks for one property: *"If Stripe webhook retried,
webhook_id already exists → skipped (no duplicate charge)."* It is enforced at
three levels, each a UNIQUE constraint rather than a read-then-write check —
because two concurrent deliveries both pass a read-then-write:

| Layer | Key | Stops |
| --- | --- | --- |
| Delivery | `PaymentWebhookEvent.id` = the provider's event id (PRIMARY KEY) | The same delivery being processed twice |
| Charge | `PaymentTransaction.idempotencyKey` | A retried checkout creating a second charge |
| Posting | `FinanceLedgerEntry.postingKey`, `RoyaltyLedgerEntry.accrualKey` | The same event booking revenue or credit twice |

Plus one guard that is not a constraint: every status transition is a
`updateMany` with the old status in the `WHERE`, so a second attempt updates
zero rows and the caller can tell.

### Failed deliveries are kept

A delivery whose *processing* fails keeps its row, unprocessed, with the error
on it, and the error is re-thrown so the provider retries. `GET
/admin/payments/webhook-events?unprocessedOnly=true` is that replay queue.

Dropping a webhook that could not be processed is how an order silently never
gets marked paid. Note the consequence of keeping it: the provider's retry will
be recognised as a replay and skipped, so the queue is drained **deliberately**,
not by hoping the provider tries again.

### What each event does

| Stripe event | Effect |
| --- | --- |
| `payment_intent.succeeded`, `charge.succeeded` | `PaymentService.settle` — order PAID, stock committed, revenue booked |
| `payment_intent.payment_failed`, `charge.failed` | `PaymentService.fail` — order CANCELLED, hold released |
| `charge.refunded`, `refund.updated` | Fills in `processedAt` on a refund initiated elsewhere |
| `charge.dispute.created` | Opens a `DisputeCase` |
| `charge.dispute.closed` | Resolves it; a loss books the chargeback and reverses the royalty |
| anything else | Recorded, acknowledged, ignored |

That last row matters: an endpoint that 400s on an event type it did not ask for
is an endpoint the provider eventually disables, taking the events that matter
with it.

## Running without a gateway adapter

`IPaymentGateway` is optional, and this deployment wires none.

Without it the platform still takes checkouts (order + hold + pending charge are
recorded), still ingests webhooks (which is how settlement is confirmed), and
still runs the whole refund workflow. What it cannot do is *initiate* a charge
or a refund server-side, so:

* the buyer completes payment through the provider's own hosted flow;
* a refund is issued in the provider's dashboard and its reference supplied to
  `POST /admin/payments/refunds/:id/process` as `gatewayRefundId` — the endpoint
  refuses with `PAYMENTS_GATEWAY_UNAVAILABLE` rather than pretending otherwise.

This is not a stub or a mock. Nothing simulates a payment, and no code path
reports money as moved when it has not.

## Gateway configuration

`PaymentGatewayConfig` binds credentials at `PLATFORM`, `ORGANIZATION` or `DROP`
scope; more specific wins. `isDefault` is cleared across the scope when a new
default is set — "two defaults" is a state with no correct interpretation, so it
is made unreachable rather than resolved by ordering at read time.

`credentialsRef` is a **pointer into the secrets manager**. No key is ever in
this database, and the DTO refuses a value matching `sk_`, `rk_`, `pk_live` or
`whsec_` with a message explaining where it should go instead. Every change is
audited `CRITICAL` with before/after — changing this column is, functionally,
changing the bank account the platform's money lands in, which is why the
capability (`payment-royalty:configure:global`) is System Admin only.
