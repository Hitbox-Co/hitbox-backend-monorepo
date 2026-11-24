# Stripe webhook setup

How to create the Stripe webhook endpoint for the HitBox backend, which events
to subscribe it to, and how to check that it works.

The backend's side of this (verification, idempotency, the replay queue) is in
[payments-and-webhooks.md](payments-and-webhooks.md). This page is the
**setup checklist**. Code: `packages/payments`
(`controller/webhook.controller.ts`, `service/webhook.service.ts`,
`domain/webhook-signature.ts`, and `STRIPE_EVENT_MAP` in
`constants/payments.constant.ts`).

---

## Why it is required

**The webhook is the only thing that marks an order paid.** `POST /checkout` and
the app's payment sheet only start a payment. The order stays `PENDING_PAYMENT`,
the stock hold runs out, and no invoice is issued until Stripe's webhook says the
money moved. Without a working webhook endpoint, every payment succeeds at Stripe
and no order is ever settled.

---

## The endpoint in this backend

| | |
|---|---|
| Method and path | `POST /webhooks/payments/stripe` |
| Full URL | `https://<your-api-host>/webhooks/payments/stripe` |
| Auth | none. The `Stripe-Signature` header is the gate |
| Mounted | **outside** `/api/v1`. It is not `/api/v1/webhooks/...` |
| Rate limit | 600 requests per minute (so retry bursts are not throttled) |
| Body | Stripe's JSON event. The backend reads the **raw bytes** to verify the signature |

Responses:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "received": true, "processed": true, "eventId": "evt_…" }` | Handled |
| `200` | `{ "received": true, "processed": false, "eventId": "evt_…" }` | A redelivery of an event already stored: ignored, nothing is done twice |
| `200` | same shape | An event type the backend does not use: stored and acknowledged |
| `400` | `PAYMENTS_INVALID_SIGNATURE` | Wrong signing secret, tampered body, or a timestamp more than 5 minutes old. Nothing is stored |
| `5xx` | error | Processing failed. The event is kept in the replay queue and Stripe will retry |
| `503` | `WEBHOOKS_UNAVAILABLE` | `STRIPE_WEBHOOK_SECRET` is not set on this server, so payments cannot be confirmed |

The URL must be **HTTPS** and reachable from the internet. A `localhost` URL
works only through the Stripe CLI (see [Local development](#local-development)).

---

## Events to subscribe to

Subscribe the endpoint to exactly these **7 events**. Anything else is stored and
acknowledged with a 200 but does nothing.

| Event | Required | What the backend does |
|---|---|---|
| `payment_intent.succeeded` | **Yes** | Settles the payment: order → `PAID`, stock hold → committed, `payments.order.settled` is published (this issues the invoice and books finance entries). Idempotent |
| `payment_intent.payment_failed` | **Yes** | Marks the payment failed with Stripe's decline message. The order is released when its hold expires |
| `refund.created` | **Yes** | Links a refund (including one made in the Stripe dashboard) to the approved refund request; an unmatched dashboard refund raises a review alert |
| `refund.updated` | **Yes** | Moves the refund to `SUCCEEDED`, `FAILED` or `CANCELED` as Stripe reports it |
| `refund.failed` | **Yes** | Marks the refund failed so staff can retry |
| `charge.dispute.created` | **Yes** | Opens a dispute case for the order |
| `charge.dispute.closed` | **Yes** | Closes the case. A **lost** dispute books the loss and reverses the royalty |

Not needed:

| Event | Why not |
|---|---|
| `charge.succeeded`, `charge.failed` | The backend also understands them, but Stripe sends them **in addition to** the `payment_intent.*` events for the same payment. Subscribing to both does no harm (settling is idempotent), but only doubles the traffic |
| `charge.refunded` | Deliberately ignored: the three `refund.*` events cover refunds |
| `payment_intent.created`, `payment_intent.requires_action`, `payment_intent.processing` | Not used. A card payment that needs 3-D Secure is confirmed later by `payment_intent.succeeded` |
| `charge.dispute.updated`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated` | Not used. Evidence and the outcome are handled through the dispute routes and `charge.dispute.closed` |

If your Stripe account is on an older API version that does not list `refund.*`
events, subscribe to `charge.refund.updated` as well and tell us: the backend only
maps the `refund.*` names today.

---

## Create the endpoint

You need **one endpoint per Stripe mode** (test and live), each with its **own
signing secret**.

### Option A: Stripe Dashboard

1. Open **Developers → Webhooks → Add endpoint** (use **Test mode** first).
2. **Endpoint URL:** `https://<your-api-host>/webhooks/payments/stripe`
3. **Select events:** add the 7 events above (search for each name).
4. Save, then open the endpoint and click **Reveal** under **Signing secret**.
   It starts with `whsec_`.
5. Put it in the backend's environment as `STRIPE_WEBHOOK_SECRET` and redeploy or
   restart.

### Option B: Stripe API

Creates the endpoint and returns its signing secret **once**, in the `secret`
field of the response. Save it immediately.

```bash
curl https://api.stripe.com/v1/webhook_endpoints \
  -u "$STRIPE_SECRET_KEY:" \
  -d url="https://<your-api-host>/webhooks/payments/stripe" \
  -d description="HitBox payments" \
  -d "enabled_events[]"=payment_intent.succeeded \
  -d "enabled_events[]"=payment_intent.payment_failed \
  -d "enabled_events[]"=refund.created \
  -d "enabled_events[]"=refund.updated \
  -d "enabled_events[]"=refund.failed \
  -d "enabled_events[]"=charge.dispute.created \
  -d "enabled_events[]"=charge.dispute.closed
```

Use a **test** secret key (`sk_test_…`) for the test endpoint and the **live**
key (`sk_live_…`) for the live one. The response contains:

```jsonc
{
  "id": "we_1Abc…",
  "object": "webhook_endpoint",
  "url": "https://<your-api-host>/webhooks/payments/stripe",
  "enabled_events": ["payment_intent.succeeded", "…"],
  "status": "enabled",
  "secret": "whsec_…"        // shown only now: this is STRIPE_WEBHOOK_SECRET
}
```

To change the events later: `POST /v1/webhook_endpoints/we_…` with a new
`enabled_events[]` list. The signing secret does not change.

### Option C: Stripe CLI (creates nothing in Stripe)

For local development only, see below.

---

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | **Yes**, for the route to exist | The endpoint's `whsec_…` signing secret. Without it the route answers `503 WEBHOOKS_UNAVAILABLE` and no order can be settled |
| `STRIPE_SECRET_KEY` | Yes, for checkout and refunds | `sk_test_…` or `sk_live_…`, **must be the same mode** as the endpoint |
| `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` | No, default `300` | How old a delivery's signature timestamp may be. Keep the server clock accurate (NTP) |

Test mode and live mode are separate worlds: a test payment sends its events only
to the **test** endpoint, signed with the **test** secret. Keep one secret per
environment, and never reuse the live one locally.

---

## Local development

Stripe cannot reach `localhost`, so forward events with the Stripe CLI:

```bash
stripe login
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.closed \
  --forward-to localhost:<PORT>/webhooks/payments/stripe
```

`stripe listen` prints `Ready! Your webhook signing secret is whsec_…`. Use **that**
value as `STRIPE_WEBHOOK_SECRET` locally (it differs from the dashboard endpoint's
secret), then restart the backend.

Trigger a test event:

```bash
stripe trigger payment_intent.succeeded
```

A triggered event is a real Stripe object that the platform did not create, so the
backend answers `200` and logs `webhook referenced a charge this platform does not
know`. To exercise a full settlement, pay for a real test order: create it with
`POST /api/v1/checkout` and confirm the returned `clientToken` (the PaymentIntent client secret) with a test card
(`4242 4242 4242 4242`), and Stripe sends the real event.

---

## Verify it works

1. **Stripe Dashboard → Developers → Webhooks → your endpoint → Event
   deliveries:** every event should show `200`. A red `400` means the signing
   secret in `STRIPE_WEBHOOK_SECRET` does not match this endpoint. A `503` means
   it is not set.
2. Pay for a test order. Within a few seconds `GET /api/v1/orders/:orderId` shows
   status `PAID` and an `invoice` object.
3. Staff view: `GET /admin/payments/webhook-events` (capability
   `payment-royalty:manage:global`) lists every delivery that arrived. Filters:
   `provider=STRIPE`, `eventType`, `unprocessedOnly=true`. The raw payload is
   never returned.

---

## Failure behaviour and replay

- **Retries:** if the backend answers non-2xx, Stripe retries for up to 3 days
  with growing gaps. Every delivery is recorded by its Stripe event id (the
  primary key of `PaymentWebhookEvent`), so a redelivery is acknowledged with
  `processed: false` and never settles an order twice.
- **A processing failure keeps its row**, unprocessed, with the error message:
  that is the replay queue. List it with `unprocessedOnly=true`.
  **There is no replay endpoint today; the queue is read-only.** Because the row
  is already stored, Stripe's automatic retry of the same event is treated as a
  duplicate (`processed: false`) and does **not** run the handler again. So a
  failed delivery needs a manual recovery: fix the cause, then either delete that
  one `PaymentWebhookEvent` row in the database and resend the event from the
  Stripe dashboard (**Event deliveries → Resend**), or reconcile the order by hand.
  Treat any row in the queue as something to act on, not something that heals itself.
- **A payment that settles after its hold expired** is parked for review, not
  lost, and no invoice is issued until staff resolve it.
- **A disabled endpoint:** Stripe disables an endpoint that keeps failing. If
  deliveries stop, check **Developers → Webhooks** for a warning and re-enable it.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Orders stay `PENDING_PAYMENT` after a successful payment | Endpoint not created, wrong URL (do not include `/api/v1`), event not subscribed, or `STRIPE_WEBHOOK_SECRET` unset (503) |
| Dashboard shows `400` on every delivery | `STRIPE_WEBHOOK_SECRET` is from a different endpoint or mode (test vs live, or the CLI secret vs the dashboard secret) |
| `400` only intermittently | Server clock drift: signature timestamps older than `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` are refused |
| Signature fails behind a proxy | The proxy must forward the **raw body** unchanged. Do not let it re-encode or parse JSON |
| `200` but the order is not settled and the log says "charge this platform does not know" | The event is for a payment HitBox did not create (a dashboard test, or another app on the same Stripe account) |
| Refund made in the Stripe dashboard shows a review alert | A refund with no matching approved refund request. Raise it through the refund workflow first, then refund |

---

## Go-live checklist

- [ ] A **live-mode** endpoint exists at `https://<prod-api-host>/webhooks/payments/stripe` with the 7 events.
- [ ] Production `STRIPE_WEBHOOK_SECRET` is that endpoint's live `whsec_…`, and `STRIPE_SECRET_KEY` is the live `sk_live_…`.
- [ ] The test endpoint still points at staging, with its own test secret.
- [ ] A live (small) payment settles an order and issues the invoice.
- [ ] Someone is watching **Developers → Webhooks → Event deliveries** and `GET /admin/payments/webhook-events?unprocessedOnly=true`.
