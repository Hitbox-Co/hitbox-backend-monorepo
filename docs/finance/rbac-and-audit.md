# RBAC and the audit trail

Who can see and do what with money, and what gets written down.

## No new capabilities were added

The permission catalog already had everything this needed:

| Capability | What it gates here |
| --- | --- |
| `payment-royalty:read:own` | An artist's own royalty accrual and balance |
| `payment-royalty:read:organization` | A brand's own royalties, and its managed artists' |
| `payment-royalty:read:global` | Every payment, royalty, refund and dispute |
| `payment-royalty:manage:global` | Royalty rules, payout batches, adjustments, payment review, disputes |
| `payment-royalty:configure:global` | Gateway credential bindings (System Admin only) |
| `payment-royalty:override:global` | Reversing a posting outside the normal calculation |
| `order:refund:global` | Approving and executing a refund |
| `order:create:own` | Checkout |

That they already existed is a good sign about the authorization design: the
finance feature turned out to be expressible in the vocabulary the platform
already had.

## Scope is resolved from the grant, never from the request

This is the rule that matters, and it is worth being blunt about why: what leaks
when it goes wrong is another party's revenue.

`buildFinanceAccess(principal)` and `buildPaymentAccess(principal)` read the
caller's permission keys and return a scope. Every service then applies a filter
built from that scope, in the query — never a check after the read.

```ts
// packages/finance/src/domain/scope-filter.ts
GLOBAL       → {}
ORGANIZATION → { OR: [ { payeeOrganizationId: { in: orgIds } },
                       { payeeArtist: { organizationId: { in: orgIds } } } ] }
OWN          → { payeeArtistId: <the caller's artist profile> ?? NO_MATCH }
```

Three properties follow:

**There is no widening parameter.** `?artistId=` is a *filter* applied on top of
the scope clause, not a replacement for it. An artist passing another artist's
id gets an empty page.

**It fails closed.** An OWN-scoped caller with no artist profile gets
`payeeArtistId = '00000000-…'`, which matches nothing — not an empty filter that
would match everything. A refactor that loses the artist lookup returns zero rows
rather than the platform's entire ledger. There is a test for exactly that.

**Missing and forbidden look the same.** A record outside the caller's scope
returns 404, not 403 — a distinct 403 confirms the record exists, and the
existence of a royalty entry scoped to another brand is itself commercial
information.

### ORG scope reaches managed artists

A brand that signed an artist can see what that artist earned — that is the
point of a brand dashboard — via `Artist.organizationId`. It cannot see an
artist it does not manage.

### Disputes are platform-only

`DisputeCase` scope for anything below GLOBAL is `{ id: NO_MATCH }`. A buyer has
no view of the case a network opened on their behalf, and an artist none at all.
The document says the refund workflow is HitBox-only; a chargeback is more so.

## Read is not write

A capability check on a route cannot tell `:organization` from `:global` — it
only knows the caller holds *something*. So every write re-checks the scope in
the service:

```ts
requireManage(access, 'schedule royalty payouts');   // needs :global
requireOverride(access, 'reverse a royalty posting'); // needs :global
requireRefund(access, 'approve refunds');             // needs order:refund:global
```

A Finance Admin holding `payment-royalty:read:global` can see every royalty on
the platform and cannot schedule a payout. That is the catalog's existing
distinction, honoured rather than flattened.

Reversal takes `override` **on top of** the route's `manage`: cancelling an
accrual the calculation says is owed is a different power from running the
calculation.

## What lands in the audit trail

Written through `@hitbox/audit`'s recorder port — the platform's existing
append-only trail, not a second finance-only log. See
[finance-revenue-ledger.md](finance-revenue-ledger.md#financial_audit_log-a-different-name-the-same-guarantee)
for why.

| Event type | Severity | Written when |
| --- | --- | --- |
| `payment.settle` | CRITICAL | A charge settles, or a parked transaction is reviewed |
| `royalty.accrue` | INFO | A royalty accrues at a claim |
| `royalty.rule.change` | CRITICAL | A rule is created or closed |
| `royalty.payout.schedule` | WARNING | Entries are batched |
| `royalty.payout.execute` | CRITICAL | A batch is approved, paid or failed |
| `royalty.override` | CRITICAL | A posting is reversed or clawed back |
| `adjustment.create` | CRITICAL | A correction is posted |
| `order.refund` | CRITICAL | A refund is confirmed-returned, approved or rejected |
| `refund.process` | CRITICAL | A refund is executed |
| `payment.gateway.configure` | CRITICAL | Credentials binding created or changed |
| `dispute.open` | CRITICAL | A chargeback arrives |
| `dispute.resolve` | CRITICAL | Evidence is submitted, or the case closes |

`royalty.accrue` is INFO because it happens on every claim and is valuable in
aggregate. Everything that **moves money, changes what someone is owed, or
changes where money lands** is CRITICAL.

Every record carries actor (with type — `SYSTEM` for webhook-driven changes),
timestamp, resource, `correlationId`, and before/after state. For example, a
refund execution records:

```jsonc
{ "eventType": "refund.process", "actor": { "type": "HITBOX_EMPLOYEE", "id": "…" },
  "beforeState": { "status": "APPROVED" },
  "afterState": { "status": "PROCESSED", "gatewayRefundId": "re_…",
                  "amount": "100.00", "currency": "USD",
                  "nfcTagCondition": "DAMAGED",
                  "resaleBlockedUntil": "2026-12-20T…",
                  "claimRevokedAt": "2026-09-21T…" } }
```

### Written inside the transaction where it matters

Reversals and payout writes pass `{ tx }` to the recorder, so the change and its
audit row commit together. Awaiting alone still allows a committed change whose
audit row failed — and a correction nobody can account for is exactly what the
immutability principle exists to prevent.

### What is deliberately not logged

The gateway `credentialsRef` is recorded (it is a pointer, not a secret); no API
key, card number or provider payload is. The webhook replay queue endpoint does
not return the stored raw `payload` for the same reason.

## Two open items

**The audit read API is not mounted.** `@hitbox/audit` is constructed in
bootstrap for its recorder, but its admin router is not mounted — that is a
separate surface with its own step-up-gated export route, and wiring it was out
of scope here. The trail is being *written*; reading it currently means querying
`AuditEvent` directly.

**Append-only is enforced by code, not by a trigger.** Nothing in the audit
module issues an `UPDATE` or `DELETE` against `AuditEvent`. The source document
asks for database triggers preventing them, which would also stop a direct
connection with write access. Recorded in [coverage-matrix.md](coverage-matrix.md).
