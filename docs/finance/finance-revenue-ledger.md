# The design, and how it maps onto this codebase

> Source: *HitBox Collectibles — Finance & Revenue Ledger Database Schema,
> v1.0*, 14 September 2026.

The source document specifies 11 tables. Seven of them already existed in this
repository under names chosen by the platform's own naming convention
(PascalCase models, no `_` prefixes), four did not exist at all, and two more
were added because the document's *workflows* need state the 11 tables cannot
hold on their own.

**Existing names were kept.** `payment_transaction` is `PaymentTransaction`
here and stays that way; renaming a table to match a document's casing would
churn every module that reads it and buy nothing. What mattered was that every
*capability* the document describes exists.

## The 11 tables

| # | Document | This codebase | Owner module | Status |
| --- | --- | --- | --- | --- |
| 1 | `order` | `Order` | `@hitbox/orders` | Existed. **Extended**: `claimId`, `claimedAt` (see below). |
| 2 | `payment_transaction` | `PaymentTransaction` | `@hitbox/payments` | Existed. **Extended**: `settledAt` + read indexes. Service, API and settlement path are new. |
| 3 | `inventory_reservation` | `InventoryReservation` | `@hitbox/orders` | Existed. Reserve / commit / release / expiry-sweep logic is new. |
| 4 | `payment_webhook_event` | `PaymentWebhookEvent` | `@hitbox/payments` | Existed. Signature verification and idempotent ingestion are new. |
| 5 | `payment_gateway_config` | `PaymentGatewayConfig` | `@hitbox/payments` | Existed. Scope resolution and admin CRUD are new. |
| 6 | `royalty_rule` | `RoyaltyRule` | `@hitbox/finance` | Existed. **Extended**: `payoutThreshold`, `payoutFrequency`, scope indexes. |
| 7 | `royalty_ledger_entry` | `RoyaltyLedgerEntry` | `@hitbox/finance` | Existed as a stub. **Heavily extended** — see below. |
| 8 | `refund_request` | `RefundRequest` | `@hitbox/payments` | Existed. **Extended**: `reasonCode`, `currency`, `physicalReturnRequired`, `nfcTagCondition`, `rejectionReason`, `processedAt`, `claimRevokedAt`, `resaleBlockedUntil`. |
| 9 | `dispute_case` | `DisputeCase` | `@hitbox/payments` | **New table.** |
| 10 | `adjustment_entry` | `AdjustmentEntry` | `@hitbox/finance` | **New table.** |
| 11 | `financial_audit_log` | `AuditEvent` (+ `AuditEventType`, `AuditRetentionPolicy`) | `@hitbox/audit` | Existed, unused by finance. Now written by every money path; eight new event types registered. |

### Two tables beyond the eleven

**`RoyaltyPayout`.** The document's timeline has three distinct acts — *"Oct 31:
threshold met, entries → pending_payout"*, *"Nov 5: finance approves"*, *"Stripe
executes payout of $506.25"* — and 11 tables with nowhere to record which
entries, who approved, and what the provider did. Smearing that across 45
`royalty_ledger_entry` rows would mean no single row says what the artist was
actually paid, and reconciling a bank statement against the ledger would be a
`GROUP BY` and a hope. The batch is its own row; the entries still carry their
own `status`.

**`FinanceLedgerEntry`.** Already existed in the repository and is kept: it is
the platform's own side of the books (revenue, cost, gateway fees, chargebacks,
royalty expense, payouts), which is what makes `GET /admin/finance/revenue-summary`
answerable without re-deriving margin from the catalog on every request.

## What changed on `royalty_ledger_entry`, and why

The pre-existing model held `orderId`, `ruleId`, `amount`, `currency`,
`entryType`, `adjustsEntryId`. That is enough to record *that* money is owed
and not much else. The document's lifecycle needs three more things:

**It needs to know what triggered it.** `skuId` and `claimId` say which
physical item's claim accrued this. Both are plain ids with **no foreign key**:
the ledger has to stay readable and summable after a claim is revoked, and a
revocation that failed on a referential check would leave money unaccounted
for. The same reasoning the audit module uses for its actor ids.

**It needs to carry its own arithmetic.** `basis`, `percentage`,
`grossRevenue`, `costOfGoods`, `netProfit` are snapshots taken at accrual. The
document's example — $100 gross, $25 COGS, 15%, $11.25 — has to remain
checkable in three years, after the price row has changed twice and the artist's
deal has been renegotiated. Recomputing it from today's catalog would produce a
different number and no way to tell which one was right.

**It needs a status, and a payee.** `status` moves `ACCRUED → PENDING_PAYOUT →
PAID`, exactly the transitions the document's timeline describes, with
`REVERSED` for a cancelled accrual. `payeeType` + `payeeArtistId` /
`payeeOrganizationId` say who is owed — an artist deal and a brand deal settle
to different parties, and the distinction has to survive into reporting.

And one column that is pure defence: **`accrualKey`, UNIQUE**. It is
`claim:<claimId>:rule:<ruleId>:payee:<payeeId>`, and it is the entire
duplicate-accrual guard. A redelivered claim event, a retried job and a manual
re-run all collide on it, and the second write is a no-op rather than a second
credit to the artist.

## What changed on `order`

Two columns: `claimId` and `claimedAt`.

The document's most important structural decision is that **payment and
ownership are decoupled** — the order is paid on day 1 and claimed on day 6,
and *the royalty accrues at the claim*. That decision only means something if
the system can tell the two apart. `Order.claimId` is how: an order with a null
`claimId` is paid-but-unclaimed, has earned nobody anything, and is exactly the
population you want to query when a drop's items are not arriving.

It is deliberately **not** a foreign key to `ProductClaim`. Claims owns that
record and a revocation must never be blocked by an order row pointing at it.

## What changed on `refund_request`

The document's refund scenario is not a card reversal — it is an exchange of a
physical object, and the columns follow from that:

* `physicalReturnRequired` / `physicalReturnConfirmedAt` — money moves only
  once the item is back (D4-35 step 2).
* `nfcTagCondition` — what the warehouse actually found. The document's
  scenario is a tag that stopped responding, and `DAMAGED` there is not a note,
  it is the input to the quarantine decision.
* `resaleBlockedUntil` — *"NFC tag flagged against resale for 90 days"*. The
  reasoning is anti-counterfeiting rather than stock control: a tag that
  "stopped responding" may equally have been cloned, and the worst outcome is
  the original re-entering circulation beside its copy.
* `claimRevokedAt` — *"If claimed before return: ownership revoked"*.
* `reasonCode` — the free-text reason stays, but reporting needs to group.
  "defective tag" is a manufacturing signal; "changed mind" is not.
* `rejectionReason`, `processedAt`, `currency` — completing the record.

## What `dispute_case` is for, and why it is not a refund

A refund is something HitBox decides to do. A dispute is something a card
network does to HitBox. They differ in every way that matters to the code:

| | Refund | Dispute |
| --- | --- | --- |
| Who starts it | buyer or support | the card network |
| Clock | none | `evidenceDueBy` — **missing it loses the case by default** |
| Physical return | required before money moves | irrelevant; the money is already gone |
| Cost | the sale | the sale **plus a network fee** |
| Ledger effect | one `REFUND` line | a `CHARGEBACK` line **and** a `GATEWAY_FEE` line |

That last row is why a lost dispute posts two entries rather than one: revenue
that evaporated and a cost of doing business are different questions, and a
single combined figure hides both.

Only a **lost or accepted** dispute reverses the artist's royalty. A dispute
that is merely open must not: the artist has not been overpaid yet, and
reversing on the accusation would mean un-reversing every time HitBox wins.

## `financial_audit_log`: a different name, the same guarantee

The document asks for an immutable, append-only log with actor, timestamp and
before/after values, and triggers preventing `UPDATE`/`DELETE`.

This platform already has exactly that in `@hitbox/audit` — `AuditEvent`, with
a composite `(eventId, occurredAt)` primary key for time-range partitioning,
`beforeState`/`afterState` JSON, `correlationId` stitching one request's events
together, actor role snapshots, and a retention policy per severity. Building a
second, finance-only audit table beside it would have produced two half-complete
trails and a question about which one a reviewer should read.

So finance and payments became writers of the existing trail. Eight event types
were registered in the catalog (`payment.settle`, `royalty.accrue`,
`royalty.rule.change`, `royalty.payout.schedule`, `royalty.payout.execute`,
`adjustment.create`, `dispute.open`, `dispute.resolve`), joining the four that
already existed (`order.refund`, `refund.process`, `payment.gateway.configure`,
`royalty.override`). See [rbac-and-audit.md](rbac-and-audit.md).

**One honest gap:** the append-only property is enforced today by code — nothing
in the audit module issues an `UPDATE` or `DELETE` against `AuditEvent` — and
not yet by a database trigger. The document asks for triggers. That is recorded
in [coverage-matrix.md](coverage-matrix.md) as an open item rather than quietly
treated as done, because "no code path does this" and "the database will refuse
it" are different guarantees and only the second one survives a direct
connection with write access.
