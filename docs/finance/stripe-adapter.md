# Stripe adapter — setup and behaviour

The Stripe adapter is what lets the backend **move money itself**. With it,
refund **Process** issues the refund in Stripe directly. Without it, an admin
has to issue the refund in the Stripe dashboard and paste Stripe's refund id.

| | No adapter (no key set) | Adapter wired (key set) |
|---|---|---|
| Checkout | Order + hold + pending charge recorded; payment happens in Stripe's hosted flow | Also creates the Stripe **PaymentIntent** and returns its `clientToken` (client secret) |
| Refund **Process** | Needs `{ "gatewayRefundId": "re_…" }` from the Stripe dashboard | `{}` is enough — the server calls Stripe and stores the `re_…` id |
| Settlement | Webhook | Webhook (unchanged — still the only proof money moved) |

Related: [payments-and-webhooks.md](payments-and-webhooks.md) ·
[refunds-and-disputes.md](refunds-and-disputes.md) ·
[orders/order-payments-and-refunds-api.md](../orders/order-payments-and-refunds-api.md)

---

## 1. Turn it on

1. In the Stripe dashboard, switch to **Test mode** → Developers → API keys → copy the **Secret key** (`sk_test_…`).
2. Add it to the root `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   ```
3. Restart the backend. The log says:
   `Stripe adapter wired — checkout and refund processing call Stripe`.

That's all. Remove the variable and restart to go back to the dashboard-only mode.

**Safety:** outside `NODE_ENV=production`, a live key (`sk_live_…` / `rk_live_…`)
is **refused** with a warning in the log. A dev machine pressing Process on
seeded data can never send real money.

---

## 2. How the key is found

The database never holds a key. `PaymentGatewayConfig.credentialsRef` holds a
**pointer**, and the backend resolves it at the moment of each Stripe call
(`apps/backend/src/adapters/stripe-secrets.ts`):

| `credentialsRef` | Reads |
|---|---|
| `secrets://stripe/platform` | `STRIPE_SECRET_KEY_PLATFORM`, else `STRIPE_SECRET_KEY` |
| `secrets://stripe/<name>` | `STRIPE_SECRET_KEY_<NAME>`, else `STRIPE_SECRET_KEY` |
| `env:STRIPE_…` | that variable (only `STRIPE_*` names are allowed) |

So the seeded configs work with just `STRIPE_SECRET_KEY`. An organization on
its own Stripe account (e.g. `secrets://stripe/ronin`) gets
`STRIPE_SECRET_KEY_RONIN` — no code change. Moving to a real secrets manager
means replacing that one resolver function.

The adapter is wired when **any** `STRIPE_SECRET_KEY*` variable is set. A
config whose pointer has no key behind it fails only when it's used, with
`PAYMENTS_GATEWAY_UNAVAILABLE` — one org missing a key doesn't stop the rest.

---

## 3. What Process does with the adapter

`POST /admin/payments/refunds/:refundId/process` with `{}`:

1. Finds the order's settled payment and its Stripe reference (`pi_…`, or `ch_…`).
2. Resolves the key for the order's gateway config.
3. Calls Stripe `POST /v1/refunds`:

   | Stripe field | Value |
   |---|---|
   | `payment_intent` / `charge` | the payment's `gatewayRef` |
   | `amount` | the refund amount in minor units (`2499.00 INR` → `249900`) |
   | `reason` | `DUPLICATE_CHARGE` → `duplicate`, `FRAUDULENT_CHARGE` → `fraudulent`, anything else → `requested_by_customer` |
   | `metadata` | `refundRequestId`, `orderId`, `reason` (free text) |
   | `Idempotency-Key` header | `refund:<refundRequestId>` |

4. Stores Stripe's `re_…` as `gatewayRefundId`, then does everything else
   Process always does (order → REFUNDED, claim revoked, resale block, royalty
   reversed).

**If Stripe fails, nothing in HitBox changes.** The refund stays `APPROVED`
and Process can simply be pressed again. The idempotency key means a retry can
never refund twice — Stripe returns the first result.

**Manual override still works.** Passing `gatewayRefundId` skips the Stripe
call and just records it — use it when a refund was already issued in the
dashboard. (With the webhook set up, even that is automatic — see §6.)

Card refunds usually show as `pending` at first and reach the buyer in 5–10
business days. The refund's `gatewayStatus` starts as `PENDING` (or
`SUCCEEDED` if Stripe settled at once) and the `refund.*` webhooks move it on
— see §6.

---

## 4. Errors

All are `400`, so the admin sees the real reason (a 5xx would be masked).
`details` carries `providerCode` (Stripe's error code) and
`providerRequestId` (Stripe's `req_…`, searchable in the dashboard logs).

| Code | Meaning | What to do |
|---|---|---|
| `PAYMENTS_GATEWAY_UNAVAILABLE` | No adapter wired, or no key behind this config's `credentialsRef` | Set the key, or issue in the dashboard and pass `gatewayRefundId` |
| `PAYMENTS_GATEWAY_REJECTED` | Stripe answered "no" — e.g. `charge_already_refunded`, `resource_missing` (unknown `pi_…`), amount too large | Read the message. If it was already refunded in the dashboard, pass that `gatewayRefundId` |
| `PAYMENTS_GATEWAY_UNREACHABLE` | Network failure, Stripe 5xx, or rate-limited (429) | Press Process again — safe to retry |
| `PAYMENTS_NOT_REFUNDABLE` | The order has no settled payment with a Stripe reference | — |

Checkout uses the same three codes, with "start this payment" in the message.

---

## 5. Testing it locally

Seeded payments have fake references (`pi_demo_12`) that don't exist in
Stripe, so refunding them would fail with `PAYMENTS_GATEWAY_REJECTED`
("No such payment_intent"). Give them real test charges first:

```bash
pnpm db:seed:test-refunds        # refunds in every state (if not done yet)
pnpm db:stripe:test-charges      # real Stripe test charges behind them
```

`db:stripe:test-charges` creates a paid PaymentIntent in **your Stripe test
account** for every open `[TEST]` refund's order (Stripe's test card
`pm_card_visa`, same amount and currency), and points the order's payment row
at it. Pass order ids to include others:
`pnpm db:stripe:test-charges -- <orderId> <orderId>`. It refuses anything but
an `sk_test_…` key, skips rows already linked, and is safe to re-run.

Then in the admin panel:

1. Open the APPROVED test refund (scenario **E**) → **Process** with no body.
2. The refund becomes `PROCESSED` with a real `re_…` id.
3. In the Stripe dashboard (test mode) → Payments → that charge shows **Refunded**.
4. Try pressing Process on another refund whose charge you already refunded in
   the dashboard → `PAYMENTS_GATEWAY_REJECTED` with `charge_already_refunded`.

If you forward webhooks with the Stripe CLI
(`stripe listen --forward-to localhost:<port>/webhooks/payments/stripe`),
the test charges' `payment_intent.succeeded` events arrive too; they match
existing, already-settled payments and change nothing.

To test the webhook paths in §6 against test data:

- **Refund later fails:** Stripe's test card `4000 0000 0000 5126` charges
  fine but its refunds fail asynchronously (`expired_or_canceled_card`). Pay a
  test checkout with it, refund it, and the `refund.failed` webhook flags it.
  To just build the UI, use scenario **G** from `db:seed:test-refunds` — a
  refund already marked FAILED.
- **Refund issued in the dashboard:** approve a test refund (don't Process),
  refund the same charge for the same amount in the Stripe dashboard, and
  watch the refund become `PROCESSED` by itself within seconds.

---

## 6. Refund webhooks — what happens after Process

Not needed to *issue* a refund (that's a direct API call), but needed to
know what happened to the money afterwards. Subscribe the endpoint to
`refund.created`, `refund.updated` and `refund.failed`.

Each refund carries the provider's view of its money, separate from the
workflow `status`:

| `gatewayStatus` | Meaning |
|---|---|
| `null` | Stripe hasn't reported (e.g. an id typed in by hand, webhook not set up) |
| `PENDING` | Stripe accepted it; on its way to the card |
| `SUCCEEDED` | Done |
| `FAILED` / `CANCELED` | **The buyer did not get the money** (`gatewayFailureReason` says why, e.g. `expired_or_canceled_card`) |

What each webhook does:

1. **A refund HitBox issued** (matched by the `refundRequestId` the adapter
   puts in Stripe metadata, or by `gatewayRefundId`) → `gatewayStatus` is
   updated. It never goes backwards: a late `pending` can't overwrite
   `succeeded`, and retried deliveries change nothing.
2. **It FAILED or was CANCELED** → the refund is flagged
   (`gatewayStatus: FAILED`), an audit entry is written (`refund.process`,
   result `FAILURE`), an error is logged, and `payments.refund.failed` is
   published. The order stays `REFUNDED` and the claim/royalty reversals stay —
   **nothing is undone automatically**; undoing an ownership revocation by
   webhook would do more harm than a person deciding. An operator should
   contact the buyer and pay them another way (Stripe returns the failed amount
   to your balance), then note it on the order.
3. **A refund issued in the Stripe dashboard** → if the order has an
   `APPROVED` refund that hasn't been paid out, for the **same amount**, it is
   processed automatically, exactly as pressing Process would (order
   REFUNDED, claim revoked, royalty reversed), recorded as done by the
   approver with `issuedVia: PROVIDER_DASHBOARD` in the audit trail.
4. **Anything else** (no approved refund on that order, or a different
   amount) → not acted on. Audited (`order.refund`, result `FAILURE`, reason
   `NO_APPROVED_REFUND` or `AMOUNT_MISMATCH`), logged as a warning and published
   as `payments.refund.unmatched` — once, on `refund.created`. Someone moved
   money outside the workflow; review the order.

The UI surfaces this through:

- refund detail / list: `gatewayStatus`, `gatewayFailureReason`, `gatewayStatusAt`;
- a **Failed refunds** queue: `GET /admin/payments/refunds?gatewayStatus=FAILED`;
- the order page: `money.refundFailed` (non-zero = buyer not paid back) and
  the same three fields on each `refunds[]` row.

---

## 7. Where the code lives

```
packages/payments/src/
  adapters/stripe-gateway.ts         ← createStripeGateway(): PaymentIntents + Refunds over fetch, toMinorUnits()
  domain/gateway-error.ts            ← GatewayError (NOT_CONFIGURED / REJECTED / UNREACHABLE) → AppError
  domain/interfaces/payment-gateway.interface.ts ← IPaymentGateway (the port)
  service/refund.service.ts          ← process() calls gateway.createRefund; applyGatewayRefundUpdate() handles refund.* webhooks
  service/webhook.service.ts         ← maps Stripe refund events → applyGatewayRefundUpdate
  repository/refund.repository.ts    ← setGatewayStatus(): never goes backwards
  service/checkout.service.ts        ← checkout calls gateway.createCharge
packages/payments/tests/stripe-gateway.test.ts
packages/payments/tests/refund-gateway-updates.test.ts

apps/backend/src/adapters/stripe-secrets.ts ← credentialsRef → key; live keys refused outside production
apps/backend/src/bootstrap.ts               ← wires the adapter when a key is set
packages/shared/database/prisma/stripe-test-charges.ts ← db:stripe:test-charges
```

The adapter uses Stripe's REST API with `fetch` (no SDK dependency). It
implements the payments module's own `IPaymentGateway` port and is injected
by bootstrap, so no other module knows Stripe exists.
