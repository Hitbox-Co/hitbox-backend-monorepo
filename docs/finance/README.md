# Finance & Revenue Ledger

> **Naming (v3.1 / v3.1.1).** `Product` / `ProductVariant` / `ProductPrice` /
> `ProductImage` / `ProductClaim` / `ProductHistory` are now `Drop` /
> `DropVariant` / `DropPrice` / `DropImage` / `SkuClaim` / `SkuHistory` — in
> Prisma **and in the database**, as of v3.1.1. So a `Product…` mentioned below
> is the old name of a table that has since been renamed; substitute from that
> list. **No route, request or response changed.** The full mapping is in
> [schema-v3.1-changes.md](../schema-v3.1-changes.md).

Everything HitBox does with money: taking it, booking it, owing it to artists,
paying it out, and giving it back.

This folder documents the implementation of **HitBox Collectibles — Finance &
Revenue Ledger Database Schema, v2.0 (14 September 2026)**, owned by Jameela
(technical lead) and Orup (payments/finance). The source document specifies 11
tables, five design principles and two workflows; these documents say what was
built for each, where it lives, and — where the implementation differs from the
document — why.

## Start here

| Document | What it answers |
| --- | --- |
| [finance-revenue-ledger.md](finance-revenue-ledger.md) | The design, and how the specified 11 tables map onto this codebase. **Read this first.** |
| [coverage-matrix.md](coverage-matrix.md) | "Is every requirement in the document actually implemented?" — requirement by requirement, with file references. |
| [schema-changes.md](schema-changes.md) | Exactly what changed in the database, why each column exists, and how to run the migration. |
| [royalty-lifecycle.md](royalty-lifecycle.md) | Accrual → threshold → payout → reversal, with the document's LeBron example traced through the real code. |
| [payments-and-webhooks.md](payments-and-webhooks.md) | Checkout, stock holds, settlement, webhook signature verification and idempotency. |
| [refunds-and-disputes.md](refunds-and-disputes.md) | The refund workflow (D4-35), the NFC tag quarantine, and chargebacks. |
| [api-reference.md](api-reference.md) | Every endpoint added, with its capability, request and response. |
| [module-boundaries.md](module-boundaries.md) | Which module owns what, which ports connect them, and why checkout lives in payments. |
| [rbac-and-audit.md](rbac-and-audit.md) | Who can see and do what, and what lands in the compliance trail. |
| [testing.md](testing.md) | What is tested, how to run it, and what is deliberately not covered yet. |

## The five principles, and where each one is enforced

The source document opens with five design principles. They are not slogans
here — each one is a specific mechanism, and each is worth knowing where to
find, because breaking one of them is how a financial system quietly becomes
wrong:

| Principle | Mechanism | Where |
| --- | --- | --- |
| **Immutability** — no record deletion; corrections via adjustment entries | `AdjustmentEntry` is a table; ledger rows are never updated except for status; a reversal writes a new row pointing at the original | [royalty-lifecycle.md reversal](royalty-lifecycle.md#reversal-and-clawback) |
| **Idempotency** — webhooks guard against duplicate processing | The provider's event id is the PRIMARY KEY of `PaymentWebhookEvent`, so the *insert* is the check; `RoyaltyLedgerEntry.accrualKey` and `FinanceLedgerEntry.postingKey` do the same for accruals and postings | [payments-and-webhooks.md idempotency](payments-and-webhooks.md#idempotency-three-layers) |
| **Decoupled payment & ownership** — payment creates an order; ownership at NFC claim | Royalty accrues on the `claims.product.claimed` event, never on settlement; `Order.claimId` records when the two met | [royalty-lifecycle.md why the claim](royalty-lifecycle.md#why-accrual-happens-at-the-claim) |
| **Role-based access** — RBAC enforces view/edit per role | Every read narrows by the *scope of the grant* (`own` / `organization` / `global`), resolved from the caller's permissions, never from a query parameter | [rbac-and-audit.md](rbac-and-audit.md) |
| **Audit trail** — every action logged with actor, timestamp, before/after | Written through the existing `@hitbox/audit` recorder; eight new event types registered | [rbac-and-audit.md audit](rbac-and-audit.md#what-lands-in-the-audit-trail) |
| **Regional pricing** — fixed per market (USD / INR) | `ProductPrice` is per (product, variant, market); checkout refuses a market with no price row rather than converting | [payments-and-webhooks.md pricing](payments-and-webhooks.md#regional-pricing) |

## The one-paragraph version

A buyer checks out: an order is created, a serialized unit is held for fifteen
minutes, and a pending charge is recorded. Stripe's webhook — signature-verified
over the raw bytes, deduplicated on its own event id — settles the order and
books the revenue. Days later the buyer taps the NFC tag; that claim is what
accrues the artist's royalty, calculated as `(gross − COGS) × rate` and written
as an immutable ledger entry carrying its own arithmetic. When the artist's
accrued balance crosses their threshold, finance sweeps it into a payout batch,
approves it, and records the provider's payout reference. If the item comes
back, the refund workflow holds the money until the return is confirmed,
revokes the claim, quarantines a damaged tag for 90 days, and reverses the
royalty with an adjustment entry — never a deletion.
