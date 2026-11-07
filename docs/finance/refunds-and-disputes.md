# Refunds and disputes

Two ways money goes back out, with almost nothing in common.

> Building the admin screens? The endpoint-by-endpoint guide — request and
> response shapes, `allowedActions`, the order's `money` summary — is
> [orders/order-payments-and-refunds-api.md](../orders/order-payments-and-refunds-api.md).

## The refund workflow (D4-35)

The source document specifies six steps:

> 1. Buyer/Support requests refund
> 2. Physical return must be confirmed received
> 3. HitBox Admin manually triggers refund approval
> 4. If claimed before return: ownership revoked, tag flagged
> 5. Refund executed via payment gateway
> 6. Royalty ledger entry reversed via adjustment entry

Steps 1–3 are the state machine in
`packages/payments/src/domain/refund-workflow.ts`. Steps 4–6 are what
`RefundService.process` does once the machine allows them.

```text
                 ┌──────────────┐
   request ─────▶│  REQUESTED   │──────────────┐
                 └──────┬───────┘              │
                        │ physical goods       │
                        ▼                      ▼
              ┌───────────────────┐      ┌───────────┐
              │  AWAITING_RETURN  │─────▶│ REJECTED  │
              └─────────┬─────────┘      └───────────┘
      confirm-return    │                      ▲
      (tag condition)   │  approve             │
                        ▼                      │
                  ┌───────────┐                │
                  │ APPROVED  │────────────────┘
                  └─────┬─────┘
                        │ process
                        ▼
                  ┌───────────┐
                  │ PROCESSED │   terminal
                  └───────────┘
```

### Money never moves before the item is back

A refund on a physical collectible is not a card reversal, it is an exchange,
and the platform has no leverage once the money is gone. So `AWAITING_RETURN` is
not a status someone can skip by pressing approve: `approve` refuses with
`PAYMENTS_RETURN_NOT_CONFIRMED` unless `physicalReturnConfirmedAt` is set.

It *can* be overridden — a lost shipment or a goodwill refund is a legitimate
thing to do — but only with `overridePhysicalReturn: true` **and**
`overrideReason`, and the audit record says which. The point is that it reads as
a decision in the trail rather than as a normal approval.

A digital-only order sets `physicalReturnRequired: false` at request time and
skips the hold entirely.

### Returns close 10 days after delivery

`RETURN_WINDOW_DAYS` (default 10) after `Order.deliveredAt`, the window
closes for good. Enforced in `RefundService` on both the photo upload and the
request:

- **no return, for anyone** — there is deliberately no staff override, so the
  window means what the buyer was told;
- **no refund at all from the buyer** on that order — otherwise a
  `physicalReturnRequired: false` request would be a return without the item;
- staff may still raise a refund with nothing sent back, which is a goodwill
  decision rather than a return.

The orders module shows the same deadline (`money.returnWindowEndsAt`,
`actions.returnWindowEndsAt`); bootstrap hands both modules the one env value,
so the screen and the rule can't drift. An order never confirmed as delivered
has no window running — delivery confirmation (admin or NFC tap) is what
starts it.

### A buyer's return is placed with photos and a description

When a buyer asks to send an item back, the request must carry 1–8 photos of
it (`RefundEvidence` → `MediaAsset`, private `return-evidence/` prefix) and a
`reason` of at least 20 characters. This is the buyer's account of the item's
condition *before* it ships, and the rest of the workflow is built on
comparing against it: the warehouse checks the parcel against the photos at
confirm-return, and the approver has both in front of them.

Two design choices worth knowing:

- **Uploads are verified, not trusted.** A `MediaAsset` row exists from the
  moment the upload URL is issued, so the row proves nothing. At request time
  the service HEADs each object in S3 and refuses any that isn't there at the
  declared size (`NOT_UPLOADED`).
- **Refund and photos are one transaction**, and `RefundEvidence.mediaAssetId`
  is unique. A return never exists without the photos it was placed with, and
  one photo can never back two returns.

Staff raising a return for a buyer (`order:refund:global`) aren't forced to
attach photos — the buyer may have called it in, and the warehouse inspection
then carries the evidence. API contract:
[orders/order-payments-and-refunds-api.md §6.0](../orders/order-payments-and-refunds-api.md#60-placing-a-return--photos-and-description).

### The tag's condition is recorded at the return, not at approval

`POST /refunds/:id/confirm-return` takes `nfcTagCondition`: `INTACT`,
`DAMAGED`, `MISSING` or `TAMPERED`. It is an *observation*, and it is what the
approval is based on.

It also drives the quarantine:

```ts
resaleBlockUntil(condition, now)   // null for INTACT, now + 90 days otherwise
```

> *"NFC tag flagged against resale for 90 days"*

The reasoning is anti-counterfeiting rather than stock control. A tag that
"stopped responding" may equally have been cloned, and the worst outcome is the
original re-entering circulation beside its copy. `INTACT` gets no block — the
item is genuinely fine, and holding it off sale costs the platform a unit for
nothing.

### What `process` actually does

Deliberately sequential rather than one transaction, because the steps span four
modules and one external system and cannot share one. The order is chosen so
that a failure leaves the least-bad state:

| # | Step | Failure means |
| --- | --- | --- |
| 1 | Gateway refund, or the operator's reference | Nothing has happened yet — safe to retry |
| 2 | `RefundRequest` → `PROCESSED`, guarded | Two operators pressing execute produce one PROCESSED and one conflict |
| 3 | **Claim revoked**, tag quarantined (`IClaimRevocation`). A damaged tag is quarantined even if the unit was never claimed | Logged loudly, left for an operator, and the unit is **not** released in step 4 |
| 4 | `Order` → `REFUNDED`; the unit goes **back into stock** if it never shipped or the return was received (`unitReturned`) | — |
| 5 | `FinanceLedgerEntry`: `REFUND`, keyed on the refund id | — |
| 6 | **Royalty reversed** (`IRoyaltyReversal`) | Logged loudly, left for an operator |

The tag step comes before the order step so a damaged unit is quarantined
before it's released, and is never on sale in between. A lost dispute marks the
order `REFUNDED` without releasing a shipped unit, because the item never came
back. The full table is in
[orders/order-payments-and-refunds-api.md 7](../orders/order-payments-and-refunds-api.md#the-unit-after-a-refund).

Steps 3 and 6 do not roll back the money steps, and that is intentional: the money has
already moved, and silently retrying a claim revocation against a unit somebody
has since transferred would do more damage than an alert.

The idempotency key on the gateway refund is `refund:<refundRequestId>`, so a
retried execute cannot send the money twice.

### Revoking the claim

`ClaimsService.revokeClaim` — payments asks through the port; claims decides
how. In one transaction:

* the `ProductClaim` is stamped `revokedAt` / `revokedReason` (never deleted —
  the claim *happened*);
* `Sku.ownerId` is cleared and `claimedStatus` reset (`FLAGGED` if quarantined,
  else `UNCLAIMED`);
* `resaleBlocked` + `tagLifecycleState = DISPUTED` if a block window applies;
* the current `ProductHistory` period is closed;
* the buyer's `BuyerCollection` row is archived;
* a **`FLAG` row extends the hash chain**.

That last point is the one worth insisting on: the chain is extended, not
rewritten. The `CLAIM` row stays and a `FLAG` row after it records that the
claim was undone. Editing it would break every subsequent hash — which is the
property the chain exists to have. Provenance that can be edited is not
provenance.

A unit that was never claimed returns `revoked: false` and is not an error:
refunding an order whose buyer never tapped the tag is ordinary.

### Over-refund guard

`request` refuses when `requested + alreadyRefunded > order.amount`, and only
one refund may be in flight per order at a time.

## Disputes

A dispute is not a refund. See
[finance-revenue-ledger.md](finance-revenue-ledger.md#what-dispute_case-is-for-and-why-it-is-not-a-refund)
for the table of differences; the operational consequences are:

**The queue sorts by deadline.** `evidenceDueBy` is the network's evidence
window and missing it loses the case by default, so `GET /admin/payments/disputes`
orders by soonest-due and takes a `dueBefore` filter for the "act now" view.

**A loss costs two lines, not one.** `postChargeback` writes a `CHARGEBACK`
entry for the sale and a separate `GATEWAY_FEE` entry for the network's fee.
Revenue that evaporated and a cost of doing business are different questions,
and a combined figure hides both.

**Only a lost or accepted dispute reverses the royalty.** A dispute that is
merely open must not: the artist has not been overpaid yet, and reversing on the
accusation would mean un-reversing every time HitBox wins.

**A redelivered dispute webhook updates the case.** `gatewayCaseRef` is UNIQUE,
so `createOrGet` returns the existing case rather than opening a second one that
would double-count the loss on resolution.

### Lifecycle

```text
OPEN ──▶ UNDER_REVIEW ──▶ EVIDENCE_SUBMITTED ──▶ WON | LOST | ACCEPTED | WITHDRAWN
```

`WON` changes nothing but the case's own status. `LOST` and `ACCEPTED` book the
chargeback, mark the order refunded and reverse the royalty with reason code
`DISPUTE_LOSS`.

## Who may do any of this

The document is explicit: *"Only HitBox Admins see refund workflow; Artist
cannot access."*

| Action | Capability |
| --- | --- |
| Request a refund on **your own** order | none beyond authentication — the service checks ownership |
| Request one on **someone else's** | `order:refund:global` |
| Confirm return / approve / reject / process | `order:refund:global` |
| Open, evidence, resolve a dispute | `payment-royalty:manage:global` |
| See any of it | `payment-royalty:read` (scope narrows the rows) |

An artist holds `payment-royalty:read:own`, which resolves to OWN scope — and
OWN scope on disputes matches nothing at all, by construction. See
[rbac-and-audit.md](rbac-and-audit.md).
