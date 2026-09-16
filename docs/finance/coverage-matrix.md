# Coverage matrix

Every requirement in *HitBox Collectibles — Finance & Revenue Ledger Database
Schema v2.0*, and what was built for it.

Status is one of **Done**, **Done (differs)** — implemented, with a deliberate
difference explained — or **Open**, meaning not built and why.

## 2 The 11 tables

| # | Table | Status | Where |
| --- | --- | --- | --- |
| 1 | `order` | Done | `packages/orders/prisma/orders.prisma` · `+ claimId`, `claimedAt` |
| 2 | `payment_transaction` | Done | `packages/payments` · schema + service + API + settlement |
| 3 | `inventory_reservation` | Done | `packages/orders` · reserve / commit / release / expiry sweep |
| 4 | `payment_webhook_event` | Done | `packages/payments` · signature verification + idempotent ingestion |
| 5 | `payment_gateway_config` | Done | `packages/payments` · scope resolution + admin CRUD |
| 6 | `royalty_rule` | Done | `packages/finance` · `+ payoutThreshold`, `payoutFrequency` |
| 7 | `royalty_ledger_entry` | Done | `packages/finance` · `+ status`, payee, arithmetic snapshot, `accrualKey` |
| 8 | `refund_request` | Done | `packages/payments` · `+ 8` workflow columns |
| 9 | `dispute_case` | Done | `packages/payments` · new table + full lifecycle |
| 10 | `adjustment_entry` | Done | `packages/finance` · new table |
| 11 | `financial_audit_log` | Done (differs) | `@hitbox/audit`'s `AuditEvent` — an existing append-only trail rather than a second finance-only table. Same guarantees (actor, timestamp, before/after, correlation, retention). See [finance-revenue-ledger.md](finance-revenue-ledger.md#financial_audit_log-a-different-name-the-same-guarantee). |

Plus one table beyond the eleven: **`RoyaltyPayout`**, because the document's
own payout timeline has three acts (batched / approved / paid) and no specified
table records which entries, who approved, or what the provider did.

## 1 Core design principles

| Principle | Status | Mechanism |
| --- | --- | --- |
| Immutability — no deletion, corrections via adjustment entries | Done | `AdjustmentEntry`; ledger rows never edited except status; reversal writes a new row pointing at the original; `PAID` entries get a negative clawback rather than a rewrite |
| Idempotency — webhooks guard duplicates | Done | Provider event id is the PRIMARY KEY; `accrualKey` and `postingKey` UNIQUE; every transition guarded in the `WHERE` |
| Decoupled payment & ownership | Done | Accrual subscribes to `claims.product.claimed`; `Order.claimId` records the join |
| Role-based access | Done | Scope resolved from the grant; fail-closed filters; 404 for out-of-scope |
| Audit trail — actor, timestamp, before/after | Done | 12 event types; `{ tx }` on the critical paths |
| Regional pricing — fixed per market | Done | `ProductPrice` per (product, variant, market); checkout refuses an unpriced market; no FX anywhere |

## 3 The lifecycle example

| Document step | Status | Where |
| --- | --- | --- |
| Day 1 2:15 PM — order placed, transaction `pending`, reservation `reserved` | Done | `CheckoutService.checkout` |
| Day 1 2:16 PM — webhook, transaction `succeeded`, order `paid`, reservation `confirmed` | Done | `WebhookService.handleStripe` → `PaymentService.settle` |
| Day 6 3:15 PM — claim triggers accrual, `order.claim_id` linked, entry `$11.25` | Done | `RoyaltyAccrualService.accrueForClaim`; orders' own subscriber sets `claimId` |
| Oct 31 — $506.25 ≥ $500 threshold, entries → `pending_payout` | Done | `RoyaltyPayoutService.schedule` |
| Nov 5 — finance approves, provider pays, entries → `paid` | Done | `approve` then `execute` |
| Nov 5 — *"Artist notified"* | **Open** | `finance.payout.paid` is published; no notification subscriber exists. `@hitbox/notifications` is schema-only. |
| Day 15 — refund requested, `pending_physical_return` | Done | `RefundService.request` → `AWAITING_RETURN` |
| Day 20 — return confirmed, `nfc_tag_condition = damaged` | Done | `confirmReturn` |
| Day 21 — refund approved and executed | Done | `approve` → `process` |
| Day 21 — royalty reversed via adjustment, claim revoked, tag flagged 90 days | Done | `process` steps 5–6; `resaleBlockUntil`; `ClaimsService.revokeClaim` |

## 4 Implementation notes

| Requirement | Status | Note |
| --- | --- | --- |
| `Royalty = Net Profit × rate`, `Net = Gross − COGS` | Done | `calculateRoyalty`; the document's $11.25 is a test assertion |
| Never edit or delete a financial record | Done | See immutability above |
| `financial_audit_log` append-only, **triggers prevent UPDATE/DELETE** | **Partially open** | Append-only holds in code — nothing issues an update or delete. The database triggers the document asks for are **not** created. "No code path does this" and "the database will refuse it" are different guarantees; only the second survives a direct connection. |
| Refund workflow D4-35, steps 1–6 | Done | [refunds-and-disputes.md](refunds-and-disputes.md) |

## 5 Validation & testing

| Test the document asks for | Status |
| --- | --- |
| Royalty calculation: `(gross − cogs) × pct = amount` | Done — `royalty-calculation.test.ts`, including the exact worked example |
| Idempotent webhook: same id → no duplicate ledger entry | Done — `webhook.service.test.ts`, asserts settlement runs once |
| Refund reversal: order → claimed → refund → claim revoked → tag flagged | **Partial** — the reversal branches and the 90-day quarantine are unit-tested; the full end-to-end chain needs a database |
| Audit log: no UPDATE/DELETE possible (triggers) | **Open** — see above |
| End-to-end payment → accrual → refund → correction | **Open** — no integration harness against a test database in this repo yet |
| Cross-currency scenarios (USD order, INR order, reporting) | **Partial** — the summary is per-currency by construction and never sums across; not exercised end to end |
| RBAC: artist sees only own royalties | Done — `finance-access.test.ts`, including the fail-closed case |
| No records deleted, only deactivated | Done by construction — no delete path exists in either module |
| Adjustment linked to original (traceability) | Done — `royalty-accrual.service.test.ts`; `GET /royalty-entries/:id` returns them |

## Open items, collected

Five things are not built. None is hidden behind a stub that reports success:

1. **Audit-log database triggers.** Append-only is enforced by code today. A
   migration adding `BEFORE UPDATE OR DELETE` triggers on `AuditEvent` is the
   fix, and it belongs with the audit module rather than this change.
2. **The expired-reservation sweeper is not scheduled.**
   `bootstrap().releaseExpiredReservations()` exists and is idempotent; this app
   has no job runner to call it from. Availability is unaffected — the checkout
   query already filters on `expiresAt > now` — so the effect is untidy rows,
   not oversold stock.
3. **No payout notification.** `finance.payout.paid` is published and
   `@hitbox/notifications` is still schema-only.
4. **No integration test suite.** The tests here are unit tests with fakes, and
   the fakes enforce the constraints that matter (UNIQUE keys return null rather
   than throwing). The end-to-end chain needs a test database.
5. **The audit read API is not mounted.** The module is constructed for its
   recorder; its admin router, with a step-up-gated export route, is a separate
   surface.

And one thing that is deliberate rather than pending: **no payment gateway
adapter is wired**. The platform records orders, charges and refunds and settles
them from verified webhooks, which is how card payments work. Nothing simulates
a payment; a refund with no adapter requires the operator's provider reference
and says so. See
[payments-and-webhooks.md](payments-and-webhooks.md#running-without-a-gateway-adapter).
