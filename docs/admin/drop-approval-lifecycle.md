# Drop Approval Lifecycle

How a drop gets from DRAFT to APPROVED, who is entitled to sign it off, and
what the platform records while it happens.

Base path: `/api/v1/admin/releases`
Module: `@hitbox/releases`
Owns: `ReleaseApproval`

> **Related.** Creating the drop itself:
> [product-upload-api.md](product-upload-api.md).
> The permission model: [authorization-architecture.md](../authorization/authorization-architecture.md).
> The wider admin surface: [admin-api-reference.md](admin-api-reference.md).

---

## Contents

1. [The one rule](#1-the-one-rule)
2. [Who approves what](#2-who-approves-what)
3. [The unowned drop — the auto-pass](#3-the-unowned-drop--the-auto-pass)
4. [States and transitions](#4-states-and-transitions)
5. [Versions: why a rejection is never overwritten](#5-versions-why-a-rejection-is-never-overwritten)
6. [The legal compliance tickmark](#6-the-legal-compliance-tickmark)
7. [Rejection requires a reason](#7-rejection-requires-a-reason)
8. [Reopening a decided review](#8-reopening-a-decided-review)
9. [Who can call what](#9-who-can-call-what)
10. [Minting waits for approval](#10-minting-waits-for-approval)
11. [Publishing — the last gate](#11-publishing--the-last-gate)
12. [API reference](#12-api-reference)
13. [The transaction record](#13-the-transaction-record)
14. [Errors](#14-errors)
15. [Worked examples](#15-worked-examples)
16. [Not built](#16-not-built)

---

## 1. The one rule

> **The party that owns the drop approves it, and nobody approves on their
> behalf.**

A HitBox System Admin or Drop Manager can *create* a drop for an artist. They
cannot *approve* it. If the drop belongs to an artist, the artist signs it off;
if it belongs to a brand, someone acting for that brand does.

### Why an administrator cannot stand in

An approval is not merely a state change. It carries an **explicit acceptance
of the legal compliance terms by a named person**. A platform administrator
accepting those terms on a brand's behalf would record a consent that brand
never gave — which is worse than the drop staying unapproved, because it *looks*
like consent in the audit trail.

So the administrator's powers are shaped differently, and deliberately
asymmetric:

| | Administrator |
|---|---|
| Approve someone else's drop | ❌ never |
| Reject any drop | ✅ — pulling a non-compliant drop must not wait for its owner to agree |
| Reopen a decided review | ✅ — so the owner can decide again |
| Override a decision *into* an approval | ❌ — that would manufacture the owner's consent |

**Consent is narrow. Refusal is broad.** That asymmetry is the design, not an
oversight.

---

## 2. Who approves what

Resolved at submit time from the drop's ownership and **frozen onto the
approval row**. A drop that later moves between a brand and an artist must not
retroactively change who was accountable for the version already reviewed.

| The drop's organization | `authority` | Who must decide |
|---|---|---|
| `ARTIST_INDIVIDUAL` | `ARTIST` | The artist named on the drop |
| `BRAND` | `ORGANIZATION` | Someone acting for that brand |
| `HITBOX` | `PLATFORM` | Any HitBox staff member holding the capability |
| *none, and no artist* | `NONE` | **Nobody — it auto-passes.** See 3 |
| *none, but an artist* | `ARTIST` | The artist |

### `Organization.type` is the discriminator, not "does it have an artistId"

Most brand drops have **both** an artist and an organization. A Lumen drop
carries `artistId = Lumen` *and* `organizationId = Lumen Studios (BRAND)` — the
artist is signed to the brand, and it is the **brand** that is legally
accountable.

Only an `ARTIST_INDIVIDUAL` organization means the artist is accountable for
themselves. So:

```
artistId set + organizationType = BRAND              → the BRAND approves
artistId set + organizationType = ARTIST_INDIVIDUAL  → the ARTIST approves
artistId set + no organization at all                → the ARTIST approves
```

---

## 3. The unowned drop — the auto-pass

**A drop naming neither an artist nor an organization skips the review
entirely.**

The reasoning follows straight from 1: a review exists to capture the
**owner's** consent. A drop with no owner outside HitBox has no consent to
capture and nobody the queue is waiting on. Leaving it `PENDING` would park it
in a list no one is expected to action.

### What actually happens

`POST /admin/releases` with such a drop does all of this in **one transaction**:

1. Creates a `ReleaseApproval` at version N with `authority = NONE`,
   `status = APPROVED`, `decidedAt = now`, `complianceStatus = CLEARED`.
2. Moves the drop straight to `DropStatus.APPROVED`.
3. **Files the drop under the HitBox organization** — sets
   `Drop.organizationId` to the organization whose `type` is `HITBOX`.

It has to be one transaction. A partial application leaves a drop that is
APPROVED but owned by nobody, or owned by HitBox with no approval explaining
why.

### It is a real review row, not a bypass

The row exists so **"why is this drop live?" stays answerable**. What it is not
is a *signed* one:

| Field | Value | Why |
|---|---|---|
| `legalComplianceAccepted` | **`false`** | Nobody accepted anything. Recording `true` would put a legal acceptance in the trail that no person ever gave |
| `legalComplianceVersion` | `null` | No terms were agreed to |
| `checkedById` | `null` | No person checked it. Naming the submitter would read as a sign-off they did not give |
| `comment` | Fixed `AUTO_APPROVAL_COMMENT` wording | Greppable, and a screen can recognise the case without parsing prose |
| audit `actorType` | `SYSTEM` | The platform passed this, not the submitter |

### What does *not* auto-pass

Three near-misses that are easy to get wrong, and each has a test:

- **A HitBox-owned drop** (`organizationType = HITBOX`) → `PLATFORM`. HitBox's
  own organization still has staff who sign off. "No owner" means *no
  organization row at all*, not "owned by HitBox".
- **A brand drop with no artist named** → `ORGANIZATION`. Only the total
  absence of *both* owners auto-passes.
- **An artist drop with no organization** → `ARTIST`. The artist is plainly the
  owner; treating it as unowned would hand their sign-off to HitBox.

### If no HitBox organization exists

Logged as a warning, and the drop is still auto-approved but left unfiled.
Refusing to review a drop because a reference row was never seeded would be a
confusing way to learn the database is unseeded, and the review is correct
without it.

---

## 4. States and transitions

```
                   POST /admin/releases
   ┌────────┐      (owner exists)       ┌───────────┐
   │ DRAFT  ├──────────────────────────▶│ SUBMITTED │
   └───┬────┘                           └─────┬─────┘
       │                                      │
       │  POST /admin/releases                │  POST /admin/releases/:id/decision
       │  (no artist AND no org)              │
       │                          ┌───────────┴───────────┐
       │                          ▼                       ▼
       │                    ┌──────────┐            ┌──────────┐
       └───────────────────▶│ APPROVED │            │ REJECTED │
          auto-passed,      └────┬─────┘            └────┬─────┘
          filed under HitBox     │                       │
                                 │                       │ POST /admin/releases/:id/reopen
                                 │                       │ (override only)
   POST /admin/products/:id/     │                       ▼
   publish                       │                version N+1, PENDING
   (re-checks the approval)      │                same authority as before
                                 ▼
                   ┌───────────────────────────┐
                   │  PUBLISHED  │   ACTIVE    │
                   │  (staged)   │ (storefront)│
                   └───────────────────────────┘
```

Two status fields move together and should not be confused:

| Field | Lives on | Values |
|---|---|---|
| `ReleaseApproval.status` | The review | `PENDING` → `APPROVED` \| `REJECTED` |
| `Drop.status` | The drop | `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED` |

A third, `complianceStatus`, is the reviewer's compliance verdict —
`PENDING` → `CLEARED` \| `FLAGGED` — and is separate from whether the drop was
approved. A drop can be approved with compliance `FLAGGED` if the reviewer
wants the flag on record.

> **Publishing is a separate step.** `APPROVED` is not `ACTIVE`. Nothing in
> the releases module publishes a drop — that is
> `POST /admin/products/:id/publish`, and it re-checks this approval before it
> does. See [10](#10-publishing--the-last-gate).

---

## 5. Versions: why a rejection is never overwritten

`ReleaseApproval` is **append-only per version**, with
`@@unique([productId, version])`.

Resubmitting a rejected drop creates **version N+1** rather than overwriting the
rejection. So the full review history survives, and *"why was this bounced
twice?"* is answerable six months later — which is the whole point of having a
compliance trail rather than a status column.

`GET /admin/releases/:id` returns the complete `history[]` for the drop, every
version, in order.

`GET /admin/releases?latestOnly=true` collapses to the newest version per drop
— that is the review **queue**, as opposed to every historical decision.

---

## 6. The legal compliance tickmark

Approving requires an explicit acceptance. It is enforced in **three places**,
because the approval row is the evidence someone signs their name to:

1. **The DTO** — `decideReleaseApprovalSchema` refuses `status: APPROVED`
   without `acceptLegalCompliance: true`.
2. **The service** — refuses again, in case the DTO was bypassed.
3. **The row** — `legalComplianceAccepted` and `legalComplianceVersion` are
   written at the moment of approval.

```json
POST /api/v1/admin/releases/{approvalId}/decision
{
  "status": "APPROVED",
  "acceptLegalCompliance": true,
  "comment": "Artwork rights confirmed with the label."
}
```

### The wording is versioned

`legalComplianceVersion` records **which terms were accepted**, not merely that
a box was ticked. The current version and its full text come back on
`GET /admin/releases/:id`:

```json
{
  "legalComplianceStatement": "I confirm this drop complies with all applicable laws and platform policies, that the rights to every asset in it are held or licensed, that age and odds disclosures are accurate, and that I am authorised to give this confirmation on behalf of its owner.",
  "legalComplianceVersionRequired": "2026-09-v1"
}
```

**Render the statement from this field**, never from a hard-coded string in the
frontend. When the wording changes, `LEGAL_COMPLIANCE_VERSION` is bumped and old
approvals keep pointing at the version they actually agreed to — a frontend
copy would silently show new terms next to an old acceptance.

### Rejecting does not require it

Refusing a drop carries no liability, so `acceptLegalCompliance` is not required
to reject. Requiring it would be asking someone to affirm a drop complies in the
act of saying it does not.

### Two further compliance refusals on approval

- An **age-restricted** drop (`isAgeSpecific`) with no `minimumAge` is refused
  outright.
- A drop cleared with **no odds disclosure** logs a warning rather than
  refusing — a non-randomised drop legitimately has none. See
  [the odds disclosure note](supply-inventory-api.md) and `Drop.oddsDisclosureRef`.

---

## 7. Rejection requires a reason

```json
{
  "status": "REJECTED",
  "comment": "The cover art uses a sample we do not have clearance for."
}
```

`comment` is **required** to reject and is validated at the schema level. A
rejection without a reason is the one thing that cannot be reconstructed
afterwards — the owner gets the drop back with no idea what to change.

The note is written in two places, on purpose:

- **On the row** (`comment`) — what the owner reads, and what a later version
  supersedes.
- **In the audit trail** (`metadata.note`) — which nothing supersedes.

An administrator reading the queue sees the rejection note on the approval, and
`GET /admin/releases/:id` carries every prior version's note in `history[]`.

---

## 8. Reopening a decided review

An administrator's answer to a rejection they disagree with — and to an owner
who rejected by mistake.

```json
POST /api/v1/admin/releases/{approvalId}/reopen
{ "reason": "Clearance has since been provided by the label." }
```

Requires `release-approval:override` — **HITBOX_SYSTEM_ADMIN only**.

### What it does, and what it deliberately does not

It opens **version N+1 in PENDING** with the *same authority* as the version it
came from, so **the same party is asked again**, with the administrator's reason
attached.

It does **not** approve anything. That is the entire point:

> A decided review cannot be overridden into an approval — that would record a
> legal acceptance the owner never gave. Reopen it instead, so the owner can
> approve it.

`canOverrideDecision('APPROVED', …)` refuses for every actor, including the
System Admin. Override reaches `REJECTED` only.

### Authority is carried forward, not re-derived

The drop's owner may have changed since. The party that was *asked* should be
asked again, so `authority`, `requiredArtistId` and `requiredOrganizationId` are
copied from the prior version rather than recomputed.

### A new version, not an un-decide

The rejection is evidence. `reopenedFromVersion`, `reopenedById`, `reopenedAt`
and `reopenReason` on the new row point back at what it came from.

---

## 9. Who can call what

| Role | Read | Submit | Amend | **Approve** | **Reject** | Reopen |
|---|---|---|---|---|---|---|
| **ARTIST** | own org | ✅ | ❌ | ✅ *own drops* | ✅ *own drops* | ❌ |
| **BRAND_ADMIN** | own org | ✅ | ❌ | ✅ *own brand's* | ✅ *own brand's* | ❌ |
| **BRAND_EMPLOYEE** | own org | ✅ | ❌ | ❌ | ❌ | ❌ |
| **HITBOX_SYSTEM_ADMIN** | all | ✅ | ✅ | **only PLATFORM/NONE drops** | ✅ any | ✅ |
| **HITBOX_DROP_MANAGER** | all | ✅ | ❌ | ❌ | ❌ | ❌ |
| **BUYER_COLLECTOR** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Read the System Admin row carefully — **it is the headline rule in table form.**
They reach the decision endpoint, they may reject anything, and they are
refused when they try to approve a drop an artist or brand owns.

### The capabilities behind each route

| Route | Requires |
|---|---|
| `GET /` and `GET /:id` | `release-approval:read` |
| `POST /` (submit) | **`drop:manage`** |
| `PATCH /:id` (amend) | `release-approval:manage` |
| `POST /:id/decision` | **any of** `release-approval:approve`, `:reject`, `:manage` |
| `POST /:id/reopen` | `release-approval:override` |

Two of those deserve explanation.

**Submit is gated on `drop:manage`, not a release capability.** Submitting is
something you do to *your own drop*, so whoever may edit the drop may submit it.
`HITBOX_DROP_MANAGER` holds `drop:manage:global` and only
`release-approval:read:global`.

**The decision route accepts any of three capabilities** because three
genuinely different powers arrive at it — the owner's `approve`, an
administrator's `reject`, and the queue administrator's `manage` — and **no
single one of them is held by everyone entitled to call it**.

> 🔧 **This was a real bug, fixed here.** The decision route was gated on
> `release-approval:manage` alone. `ARTIST` and `BRAND_ADMIN` hold
> `release-approval:approve:organization` and `:reject:organization`, and
> **`approve` neither is nor implies `manage`** — only `MANAGE` implies
> CRUD, and nothing implies `MANAGE`. So the two roles the entire authority
> rule exists to serve were returning `403` before the service was ever
> reached. `tests/route-capability.test.ts` locks this down.

Reaching the route is **not** the same as being allowed to decide. Which party
may approve *this* drop is resolved against the loaded row, and a `manage`
holder still cannot approve a brand's drop.

---

## 10. Minting waits for approval

**An edition may not be minted until the drop's owner has approved it.**

A serialized unit is a claim about a physical object: it gets a code, a serial
within an edition, eventually a chip and an owner. Creating those for a drop
the artist may yet reject produces inventory referring to something nobody will
ever ship — and which somebody then has to reconcile away by hand.

So minting waits for the **same clearance publication waits for**:

> The owner has approved it, **or** there is no owner to ask.

### What changed

Minting used to happen at drop creation, via the `skus` block on
`POST /admin/products`. A drop is born in `DRAFT`, so an owned drop was never
approved at the moment its units were created — the block ran before anyone had
been asked.

| Case | Before | Now |
|---|---|---|
| Drop with an artist or organization | Minted at creation | **Refused** until approved, then `POST /admin/products/:productId/skus` |
| Drop with neither (HitBox's own) | Minted at creation | **Unchanged** — still mintable at creation |

### The unowned drop is mintable immediately

A drop naming neither an artist nor an organization has no owner whose consent
is being waited on, so it is cleared **from the moment it exists** — with no
review row at all. An administrator does not have to walk HitBox's own drop
through a review that would auto-pass anyway.

That is why the gate answers from *ownership* when no review exists, rather
than simply refusing. The distinction, restated:

```
no artist AND no organization  → cleared immediately, no review needed
anything else, no review yet   → refused: "never been submitted"
anything else, review PENDING  → refused: awaiting its owner
anything else, review REJECTED → refused, quoting the rejection note
anything else, review APPROVED → cleared
```

### Where it is enforced

Both minting entry points, and the refusal names the review:

| Route | Behaviour |
|---|---|
| `POST /admin/products` with a `skus` block | `400 PRODUCTS_NOT_APPROVED` when the drop names an artist or organization |
| `POST /admin/products/:productId/skus` | `409 SKUS_NOT_APPROVED`, with `details` carrying `approvalId`, `version`, `status`, `authority` |

The second carries the review details so a console can link straight to the
approval that is blocking it.

### How it asks

The same port and the same adapter that gates publication, wired into a second
consumer:

```
@hitbox/products  declares IReleaseGate      ┐
                                             ├─▶ @hitbox/releases (ReleaseGateAdapter)
@hitbox/skus      declares ISkuReleaseGate   ┘
```

Each consumer declares the shape it needs; neither reads `ReleaseApproval`, and
releases imports neither of them.

`IReleaseGate` additionally exposes a **pure, synchronous** `requiresApproval()`
for the creation path, which has no drop row to look up yet — so the catalog can
refuse a `skus` block without keeping a second copy of the authority rule.
`resolveAuthority` stays the single source of truth.

> **When no gate is wired in, minting proceeds.** The gate is an added
> constraint on a deployment that runs the review workflow, not the authority
> on who may mint — that is the capability check on the route. Publication is
> the opposite: it *refuses* without a gate, because taking a drop live on the
> assumption an approval exists is the hole that endpoint was built to close.

---

## 11. Publishing — the last gate

`APPROVED` is not live. Publication is a separate transition with its own
route, and it is the **last point at which the owner's approval is checked**.

```
POST /api/v1/admin/products/:id/publish
{ "target": "ACTIVE", "note": "optional" }
```

| Field | | |
|---|---|---|
| `target` | `ACTIVE` \| `PUBLISHED` | Default `ACTIVE`. `ACTIVE` is what the public storefront lists (`PUBLIC_PRODUCT_WHERE`); `PUBLISHED` is staged — orders accept it, the storefront does not show it |
| `note` | string | Recorded on the audit entry, not on the drop |

Requires `drop:manage:global`.

### Why this is not `PATCH { "status": "ACTIVE" }`

It used to be, and that made **the entire approval lifecycle advisory**.

`updateProductSchema` inherited `status` from the create schema and the service
wrote it straight through with no guard. So this worked, from any status:

```
DRAFT ──PATCH { "status": "ACTIVE" }──▶ ACTIVE
```

The artist was never asked. No `ReleaseApproval` row, no tickmark, no audit
entry, and `publishedAt` left `null` for ever — it is *read* in the response
projection and was written nowhere in the codebase. Every guarantee in 1–8
held only for as long as nobody used the PATCH.

**So two things changed together**, and the second matters more than the first:

1. `POST /:id/publish` was added, with the preconditions below.
2. **`status` was removed from `updateProductSchema`.** A gate is worthless
   while an ungated door sits next to it.

`.strict()` means a client still sending `status` now gets a **422 naming the
field**, rather than having it silently ignored — a silent drop would look to
the caller exactly like the publish succeeded.

> **Frontend impact.** If your drop form sends `status` in its PATCH body, it
> will now 422. Remove the field and call `POST /:id/publish` instead.

A drop's status now moves through exactly four transitions, each owned by the
route that can check its preconditions:

| Transition | Route |
|---|---|
| `DRAFT` → `SUBMITTED` | `POST /admin/releases` |
| `SUBMITTED` → `APPROVED` \| `REJECTED` | `POST /admin/releases/:id/decision` |
| `APPROVED` → `PUBLISHED` \| `ACTIVE` | `POST /admin/products/:id/publish` |
| any → `ARCHIVED` | `DELETE /admin/products/:id` |

### The preconditions, in order

Cheapest and most fundamental first, so the reason a caller gets back is the
most useful one rather than whichever check was written first.

| # | Check | Failure |
|---|---|---|
| 1 | Not archived; not already at `target`; not `ENDED`/`ARCHIVED` | `409 PRODUCTS_NOT_PUBLISHABLE` |
| 2 | **The latest review is `APPROVED`** | `409 PRODUCTS_NOT_APPROVED` |
| 3 | Age-restricted drops carry a `minimumAge` | `400 PRODUCTS_PUBLISH_BLOCKED` |
| 4 | At least one **active price** | `400 PRODUCTS_PUBLISH_BLOCKED` |
| 5 | If `totalSupply > 0`, at least one **minted unit** | `400 PRODUCTS_PUBLISH_BLOCKED` |

Four of those deserve a sentence.

**Check 2 reads the LATEST version only.** An older `APPROVED` version does not
license publication once a newer one has been rejected or reopened. Asking "is
there any approved version" would let a drop go live on a decision that has
since been superseded.

**Check 3 is re-run rather than trusted from the approval.** The approval was
recorded against the drop as it stood then, and `isAgeSpecific` is editable
afterwards. An age flag added after sign-off would otherwise go live unchecked.

**Check 5 exists because a drop declaring supply with no minted units is
purchasable with nothing to deliver.**

**A refused publication is audited**, not just refused. Someone attempting to
take an unapproved drop live is exactly what the authority rule exists to stop,
and the refusal leaves no other trace — see 12.

### How it asks

Products owns `Drop` and therefore owns publishing it. It does **not** own
`ReleaseApproval` and does not read that table. It asks through a
consumer-defined port:

```
@hitbox/products  declares  IReleaseGate.describeLatest(productId)
@hitbox/releases  implements it  (ReleaseGateAdapter)
bootstrap         connects the two
```

If the gate is not wired in, publishing is **refused**, not allowed
(`PRODUCTS_RELEASE_GATE_UNAVAILABLE`). A deployment that cannot verify an
approval must not take drops live on the assumption that one exists — that is
precisely the hole this endpoint was built to close.

### What it writes

- `Drop.status` → the target
- `Drop.publishedAt` → now, **on first publication only**. A drop staged to
  `PUBLISHED` and later moved to `ACTIVE` keeps the moment it first went out.
  That is what `publishedAt` means; `publishAt` is the scheduled *intent* and is
  a different column.
- audit `product.publish` (CRITICAL), carrying the review it cleared
- event `products.product.published`

### Response

```json
{
  "data": {
    "product": { "id": "…", "status": "ACTIVE", "publishedAt": "2026-09-29T09:14:00.000Z", "…": "…" },
    "clearedReview": {
      "approvalId": "…",
      "version": 2,
      "status": "APPROVED",
      "authority": "ARTIST"
    }
  }
}
```

`clearedReview` is echoed back so a console can show **which** approval
authorised the drop going live, without a second request.

---

## 12. API reference

### `GET /api/v1/admin/releases`

| Query | Type | Notes |
|---|---|---|
| `status` | enum | `PENDING` \| `APPROVED` \| `REJECTED` |
| `productId` | uuid | |
| `latestOnly` | boolean | Collapse to the newest version per drop — the queue |
| `page`, `limit` | int | Default `1` / `20`, max `100` |

Organization-scoped: a brand sees reviews for their own drops.

### `GET /api/v1/admin/releases/:approvalId`

Returns the review, the full `history[]` for the drop, the legal statement, and
— importantly for the UI — **what this caller may do**:

```json
{
  "id": "…", "productId": "…", "version": 2, "status": "PENDING",
  "authority": "ARTIST",
  "requiredArtistId": "artist-kaze", "requiredArtistName": "Kaze",
  "requiredOrganizationId": null, "requiredOrganizationName": null,
  "complianceStatus": "PENDING",
  "legalComplianceAccepted": false,
  "reopenedFromVersion": 1,
  "reopenReason": "Clearance has since been provided by the label.",

  "canDecide": true,
  "canApprove": true,
  "canReject": true,
  "canReopen": false,
  "approveBlockedReason": null,
  "blockedReason": null,

  "legalComplianceStatement": "I confirm this drop complies with…",
  "legalComplianceVersionRequired": "2026-09-v1",

  "history": [
    { "version": 1, "status": "REJECTED", "comment": "Sample not cleared.", "authority": "ARTIST", "decidedAt": "2026-09-20T…" },
    { "version": 2, "status": "PENDING",  "comment": null, "authority": "ARTIST", "decidedAt": null }
  ],

  "product": { "id": "…", "groupCode": "8417", "name": "Kaze — Ember Series", "status": "SUBMITTED", "isAgeSpecific": false, "minimumAge": null, "organizationId": null, "artistId": "artist-kaze" }
}
```

**Drive the buttons from `canApprove` / `canReject` / `canReopen`**, and show
`approveBlockedReason` when approval is refused. The reasons are written to be
read on screen:

> *"Only the artist this drop belongs to can approve it. An administrator can
> reject it or send it back, but cannot approve it for them."*

### `POST /api/v1/admin/releases`

```json
{ "productId": "…", "comment": "Ready for review." }
```

Opens version N+1 and moves the drop to `SUBMITTED` — **or auto-passes it**, if
it names no artist and no organization (3). The response shape is identical
either way; check `authority === "NONE"` and `status === "APPROVED"` to tell.

Refused with `409 RELEASES_ALREADY_PENDING` if a review is already open.

### `PATCH /api/v1/admin/releases/:approvalId`

The reviewer's working notes on an **undecided** review — `comment`,
`complianceStatus`, `oddsDisclosureRef`. Refused once decided.

### `POST /api/v1/admin/releases/:approvalId/decision`

```json
{ "status": "APPROVED", "acceptLegalCompliance": true, "comment": "…" }
{ "status": "REJECTED", "comment": "Required." }
```

| Field | Required |
|---|---|
| `status` | always |
| `acceptLegalCompliance` | **must be `true` to approve**; not required to reject |
| `comment` | **required to reject** |
| `complianceStatus` | optional — defaults to `CLEARED` on approve, `FLAGGED` on reject |
| `oddsDisclosureRef` | optional |

### `POST /api/v1/admin/releases/:approvalId/reopen`

```json
{ "reason": "Clearance has since been provided." }
```

---

## 13. The transaction record

Every step is recorded through `IReleaseAudit.record()` — **awaited, and allowed
to throw**. An approval nobody can account for is not an approval.

| Event | Recorded when |
|---|---|
| `release.submit` | A review is opened |
| `release.approve` | An approval is recorded — **including the auto-pass**, with `actorType: SYSTEM` |
| `release.reject` | A rejection is recorded, with the note in `metadata.note` |
| `release.amend` | Reviewer notes changed, before/after |
| `release.reopen` | A decided review sent back |

### Denials are recorded too

An administrator attempting to approve a brand's drop is written as
`result: DENIED` **before** the 403 is thrown, carrying the authority, the
required artist/organization and the refusal reason.

That is deliberate: it is exactly the event a compliance review wants to see,
and it leaves no other trace anywhere in the system.

### Which hat the actor wore

`actorType` is derived from the actor's relationship to *this* drop, not from
their role name — the same person can be the artist on one review and a
platform administrator on another.

| | |
|---|---|
| `ARTIST` | They are the artist this drop required |
| `BRAND_EMPLOYEE` | They are a member of the brand this drop required |
| `HITBOX_ADMIN` | Anyone else |
| `SYSTEM` | Nobody — the auto-pass |

> ⚠️ **The audit row is written after the mutation commits.** A `500` carrying
> `AUDIT_WRITE_FAILED` means *"check whether the decision went through"*, not
> *"nothing happened"*. This affects `releases`, `skus` and `supply` alike —
> see [supply-inventory-api.md 12](supply-inventory-api.md).

---

## 14. Errors

| Code | Status | Meaning |
|---|---|---|
| `RELEASES_NOT_FOUND` | 404 | Also returned for a review outside your organizations |
| `RELEASES_NOT_THE_APPROVER` | 403 | **You are not the party entitled to decide this drop** |
| `RELEASES_ALREADY_DECIDED` | 409 | A decision is already recorded; reversing needs override |
| `RELEASES_ALREADY_PENDING` | 409 | A review is already open for this drop |
| `RELEASES_LEGAL_ACCEPTANCE_REQUIRED` | 400 | Approving without the tickmark |
| `RELEASES_COMMENT_REQUIRED` | 422 | Rejecting without a reason |
| `RELEASES_COMPLIANCE_INCOMPLETE` | 400 | Age-restricted drop with no `minimumAge` |
| `RELEASES_NOT_REOPENABLE` | 409 | Reopening a review that was never decided |

### Publication (`POST /admin/products/:id/publish`)

| Code | Status | Meaning |
|---|---|---|
| `PRODUCTS_NOT_APPROVED` | 409 | **The latest review is not APPROVED.** Carries `approvalId`, `version` and `status` in `details` |
| `PRODUCTS_NOT_PUBLISHABLE` | 409 | Archived, already at the target status, or `ENDED`/`ARCHIVED` |
| `PRODUCTS_PUBLISH_BLOCKED` | 400 | Missing `minimumAge`, no active price, or no minted units. `details.field` names which |
| `PRODUCTS_RELEASE_GATE_UNAVAILABLE` | 400 | The release gate is not wired in, so approval cannot be verified — publication is refused rather than assumed |

### Minting (§10)

| Code | Status | Meaning |
|---|---|---|
| `SKUS_NOT_APPROVED` | 409 | The drop's owner has not approved it. `details` carries `approvalId`, `version`, `status`, `authority` |
| `PRODUCTS_NOT_APPROVED` | 400 | A `skus` block on `POST /admin/products` for a drop that names an artist or organization — create it, get it approved, then mint |

---

## 15. Worked examples

### An artist-owned drop, rejected then approved

```
1. Drop Manager creates the drop for artist Kaze (ARTIST_INDIVIDUAL org).
   A `skus` block here would be REFUSED — Kaze has not approved it yet.
2. Drop Manager  POST /admin/releases                    → v1 PENDING, authority=ARTIST
3. System Admin  POST /admin/releases/{v1}/decision      → 403 NOT_THE_APPROVER
                 { status: APPROVED, acceptLegalCompliance: true }
                 …and a DENIED audit row is written.
4. Kaze          POST /admin/releases/{v1}/decision      → v1 REJECTED
                 { status: REJECTED, comment: "Wrong master used." }
5. Drop Manager fixes the audio.
6. System Admin  POST /admin/releases/{v1}/reopen        → v2 PENDING, authority=ARTIST
                 { reason: "Master replaced." }
7. Kaze          POST /admin/releases/{v2}/decision      → v2 APPROVED
                 { status: APPROVED, acceptLegalCompliance: true }
                 Drop → APPROVED. legalComplianceVersion = "2026-09-v1".
8. Admin         POST /admin/products/{id}/skus          → 500 units minted
                 { count: 500 }
                 Now permitted: the gate reads v2 = APPROVED.
9. Drop Manager  POST /admin/products/{id}/publish       → Drop ACTIVE
                 { target: "ACTIVE" }
                 publishedAt set. Gate re-read v2 = APPROVED before allowing it.
```

Note steps 8 and 9: both ask the gate again rather than trusting that step 7
happened. Had an administrator rejected v2 in between, publication would
have been refused with `PRODUCTS_NOT_APPROVED` naming version 2.

Every step above survives in `history[]` and in the audit trail, including the
administrator's refused attempt at step 3.

### A brand drop that also names an artist

```
Drop: artistId = Lumen, organizationId = Lumen Studios (BRAND)
  → authority = ORGANIZATION
  → the artist Lumen CANNOT approve it; a Lumen Studios member must.
```

The brand is legally accountable, and the artist is signed to it.

### A HitBox in-house drop with no artist

```
Drop: artistId = null, organizationId = null
  → authority = NONE
  → POST /admin/releases auto-passes it in one transaction:
      approval v1 APPROVED, legalComplianceAccepted = false
      Drop.status        = APPROVED
      Drop.organizationId = <the HITBOX organization>

  → and units are mintable WITHOUT even that call: the gate clears an
    unowned drop from the moment it exists, so a `skus` block on
    POST /admin/products works exactly as it always did.
```

---

## 16. Not built

| Gap | Note |
|---|---|
| **Notifications** | Nothing emails or notifies the artist that a drop awaits them. Out of scope by request — the events (`releases.approval.submitted` / `.decided` / `.reopened`) are published on the bus and are the hook a notifier would subscribe to |
| Scheduled publication | `Drop.publishAt` records a scheduled intent and **nothing acts on it**. Publishing is a call someone makes; there is no job that takes a drop live at a set time |
| Un-publish | There is no route back from `ACTIVE` to `APPROVED`. `DELETE /admin/products/:id` archives, and `isActive` is a separate kill switch the catalog already honours |
| Delegated approval | An artist cannot nominate a manager to approve for them. Approval is personal to the named artist or a member of the named brand |
| Multi-party sign-off | One decision closes a version. A drop needing both the artist *and* the label would need a second approval row per version |
| Deadlines / auto-expiry | A review sits PENDING for ever. Nothing escalates or times out |
| Bulk decisions | One review per call |
| Compliance document upload | The tickmark records acceptance of versioned *wording*. Attaching a signed PDF is not supported — `oddsDisclosureRef` is the only document pointer, and it is a URL |
