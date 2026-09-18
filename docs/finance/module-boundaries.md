# Module boundaries

Which module owns what, how they talk, and why checkout is not in the orders
module.

## The dependency graph

```text
                    claims.product.claimed  (event)
        @hitbox/claims ───────────────────────────┐
              ▲                                   │
              │ IClaimRevocation                  ▼
              │                            @hitbox/finance
      @hitbox/payments ───────────────────────────┤
              │   IFinancePostings                │ IOrderRevenueSource
              │   IRoyaltyReversal                ▼
              └──────────── IOrderLedger ──▶ @hitbox/orders
```

Every arrow is a **port** — an interface the *consumer* declares and the
*provider* implements, connected in `apps/backend/src/bootstrap.ts` — except the
dashed one from claims to finance, which is an **event**. Nothing points back.

| Port | Declared by | Implemented by | Question it answers |
| --- | --- | --- | --- |
| `IOrderLedger` | payments | `OrderLedgerAdapter` (orders) | Place, settle, cancel, refund an order; sweep expired stock holds |
| `IOrderRevenueSource` | finance | `OrderRevenueAdapter` (orders) | What was this unit sold for, and what did it cost? |
| `IFinancePostings` | payments | `FinanceLedgerService` (finance) | Book this sale / refund / chargeback / correction |
| `IRoyaltyReversal` | payments | `RoyaltyAccrualService` (finance) | Un-earn the artist's royalty on this order |
| `IClaimRevocation` | payments | `ClaimsService` (claims) | Take ownership back and quarantine the tag |
| `IPaymentGateway` | payments | *(nothing, on this deployment)* | Create a charge / a refund at the provider |
| `IFinanceAuditRecorder` / `IPaymentsAuditRecorder` | finance / payments | `AuditRecorderService` (audit) | Write the compliance trail |

This is the pattern from [../hitbox-architecture.md](../hitbox-architecture.md)
6, and it is applied here for the same reason: when payments becomes its own
service, `OrderLedgerAdapter` is reimplemented as an HTTP client and bootstrap
swaps it in. Nothing inside payments changes.

## Why checkout lives in payments, not orders

This is the one boundary decision that looks wrong at first glance, so it is
worth stating the argument.

Checkout needs both an order and a charge. One module has to depend on the
other, and a cycle is not an option. Three ways to break it:

1. **Orders depends on payments** — orders would need to know about gateways,
   credentials and provider references, which is most of the payments module
   leaking into the purchase record.
2. **Both depend on a third "checkout" module** — a module whose only job is to
   call two others, with no table of its own and no domain behind it.
3. **Payments depends on orders** — payments owns the buy flow and asks orders
   to create the record.

The third is what this does. A purchase *starts* with money; the order is the
record of it. Orders stays a module about an order's own lifecycle — status
transitions, fulfilment, addresses, stock — and knows nothing about Stripe.

The consequence is that `POST /api/v1/checkout` is served by the payments
module, which reads oddly in the route table and correctly in the dependency
graph.

## Why finance subscribes to a claim rather than calling it

Accrual is driven by `claims.product.claimed` on the event bus, not by claims
calling finance.

An event is right here because the claim does not *need* the accrual. The
buyer's tap has to succeed whatever the royalty configuration says — a missing
rule, a database hiccup in finance, a bug in the split calculation — and a
synchronous call would make the claim's success depend on all of it. The
subscriber catches its own errors for the same reason, and logs enough to replay
by hand.

Orders subscribes to the same event to set `Order.claimId`. Two independent
subscribers, neither aware of the other.

## Who may touch which table

| Table | Owner | Written by |
| --- | --- | --- |
| `Order`, `OrderAddress`, `InventoryReservation` | orders | orders only (payments goes through `IOrderLedger`) |
| `PaymentTransaction`, `PaymentGatewayConfig`, `PaymentWebhookEvent`, `RefundRequest`, `DisputeCase` | payments | payments only |
| `RoyaltyRule`, `RoyaltyLedgerEntry`, `RoyaltyPayout`, `AdjustmentEntry`, `FinanceLedgerEntry` | finance | finance only (payments goes through `IFinancePostings` / `IRoyaltyReversal`) |
| `ProductClaim`, `BlockchainLedger`, `ProductHistory`, `Sku` (claim state) | claims | claims only (payments goes through `IClaimRevocation`) |
| `AuditEvent` | audit | audit only, via the recorder port |

The rule the architecture doc states — *a repository is the only thing that
touches Prisma, and a module's repository only touches its own tables* — holds
throughout, with one documented exception below.

## The one documented shortcut

`OrderWriteRepository` reaches `order.product.productPrices` — two hops into the
products module's partial — to read `costOfGoods` and the active price for a
market.

This is the same shortcut collections already takes through `sku.product`, and
it is taken for the same reason: the cost lives on the price row, checkout and
accrual both need it, and a port for one `Decimal` would be ceremony without
benefit. It is a coupling *at the database layer only* — on extraction, the hop
becomes a call to the catalog service, exactly as the architecture doc's
extraction path describes.

It is written down here rather than left to be discovered, because an undocumented
shortcut is indistinguishable from a mistake.

## Bootstrap order

```text
orders                              (needs nothing from money modules)
  └─▶ audit                         (recorder port)
        └─▶ finance                 (orders.revenue, audit.recorder)
              └─▶ payments          (orders.ledger, finance.postings,
                                     finance.royaltyReversal, claims.revocation)
```

Claims is constructed earlier, with the rest of the NFC domain. The order is
forced by the arrows: a consumer is constructed with its providers in hand,
which is what keeps the dependency one-directional at runtime as well as on
paper.

## New event catalog entries

| Event | Publisher | Subscriber |
| --- | --- | --- |
| `claims.claim.revoked` | claims | — (collections / search / notifications are the obvious future ones) |
| `finance.royalty.accrued` | finance | — |
| `finance.royalty.reversed` | finance | — |
| `finance.payout.scheduled` | finance | — |
| `finance.payout.paid` | finance | — (artist notification is the obvious one) |
| `finance.adjustment.posted` | finance | — |
| `payments.checkout.started` | payments | — |
| `payments.payment.succeeded` | payments | — |
| `payments.payment.failed` | payments | — |
| `payments.refund.requested` / `.approved` / `.processed` | payments | — |
| `payments.dispute.opened` / `.resolved` | payments | — |

Most have no subscriber yet. They are published anyway because the payload
contract is the cheap part to get right early, and because the first thing
anyone will want — "notify the artist when their payout lands" — should be a
subscriber rather than an edit to the payout service.
