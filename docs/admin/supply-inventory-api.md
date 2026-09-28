# Supply & Inventory Management API

NFC tag and merchandise supply tracking: vendors, received consignments, the
chip inventory that comes out of them, and the metrics rollup over all of it.

Base path: `/api/v1/admin/supply`
Module: `@hitbox/supply`
Owns: `Vendor`, `SupplyBatch`, `NfcTag`

---

## Contents

1. [What this is for](#1-what-this-is-for)
2. [The four capabilities](#2-the-four-capabilities)
3. [Who can do what](#3-who-can-do-what)
4. [The intake flow, end to end](#4-the-intake-flow-end-to-end)
5. [Vendors](#5-vendors)
6. [Consignments](#6-consignments)
7. [The chip manifest](#7-the-chip-manifest)
8. [Chip inventory](#8-chip-inventory)
9. [Supply & inventory metrics](#9-supply--inventory-metrics)
10. [Tag UID handling](#10-tag-uid-handling)
11. [Errors](#11-errors)
12. [The audit trail](#12-the-audit-trail)
13. [Deployment](#13-deployment)
14. [Not built](#14-not-built)

---

## 1. What this is for

This module is the **upstream of `@hitbox/skus`**. The distinction the two
modules draw between them:

| Thing | Table | Module | What it is |
|---|---|---|---|
| A serialized item | `Sku` | `@hitbox/skus` | "#014 of 500" — a physical collectible |
| The chip inside it | `NfcTag` | `@hitbox/supply` | The NFC chip embedded in that item |
| Where both came from | `SupplyBatch` | `@hitbox/supply` | A received carton |
| Who made it | `Vendor` | `@hitbox/supply` | The manufacturer |

A chip has a life the item does not: it is QC'd before it is bound, it can be
replaced while the item keeps its provenance, and its UID must stay unique for
ever even after it is retired. That is why it is a row of its own rather than
five columns on `Sku`.

**What was already here before this work:** the three tables, and a read-only
`GET /admin/dashboard/supply` that listed consignments and counted active
vendors. There were no write endpoints, no chip inventory API at all, and no
metrics — `NfcTag` was reachable only from a backfill script. This document
covers the module that now fills that in.

---

## 2. The four capabilities

Supply holds three different secrets with three different audiences, so it is
gated by three resources rather than one "can you see supply" flag — plus a
fourth for the rollup.

| Constant | Capability | Reaches |
|---|---|---|
| `SUPPLY_READ_CAPABILITY` | `drop:read` | Consignment **headers**: who shipped what, when, how many |
| `SUPPLY_TAG_READ_CAPABILITY` | `nfc-tag-claim:read` | The **chip inventory**: codes, QC, lifecycle, bindings |
| `SUPPLY_WRITE_CAPABILITY` | `nfc-tag-claim:manage` | Recording intake — vendors, consignments, manifests, QC |
| `SUPPLY_METRICS_CAPABILITY` | `reports-dashboards:read` | The aggregate rollup, no row-level detail |

### Why consignments are gated on `drop:read`

A consignment header is planning data for whoever runs the drop, and
`HITBOX_DROP_MANAGER` holds no `nfc-tag-claim` grant at all. Gating headers on
tag custody would lock that role out of a screen it cannot do its job without.
This also matches the gate the dashboard's own `supply` section already uses.

The consequence worth stating out loud: **a Drop Manager sees every carton on
the platform and not one chip.** That is intended. Whoever plans the drop needs
to know 5,000 chips arrived; they do not need to know which 5,000.

### 🔒 `drop:read:public` is not an operator grant

`BUYER_COLLECTOR` holds `drop:read:public`, and in this system **PUBLIC scope
has `ScopeBreadth.ALL`** — visibility is what PUBLIC narrows, not reach. So a
bare `requirePermission('drop:read')` on these routes would admit every
signed-in buyer on the platform.

The route guard cannot tell the difference, because a grant did match. So
`buildSupplyAccess()` looks at the **scope of the grant that matched** and
discards `PUBLIC` and `OWN` before anything else runs
([`domain/supply-access.ts`](../../packages/supply/src/domain/supply-access.ts)).
This is the same hole, and the same fix, as `buildSkuAccess()` in
`@hitbox/skus`.

### Writes are `globalOnly`

Every write route is mounted `globalOnly`. Supply intake is a platform custody
function: a brand does not take delivery of the platform's chip stock, and an
organization-scoped grant on these routes would let one brand register chips
against another brand's consignment.

Reads stay organization-scoped. Writes do not.

### The vendor directory is platform-level

Reading vendors additionally requires **GLOBAL** reach, not merely a
consignment grant. A brand may see the consignments ordered *for their own
drops* — that is their supply — but who HitBox buys chips from, on what terms
and at which contact address is a commercial relationship of the platform's.

An organization-scoped caller hitting `/vendors` gets `403`, and the `vendors`
block is omitted from their metrics rollup.

---

## 3. Who can do what

| Role | Metrics | Vendors read | Vendors write | Consignments read | Consignments write | Manifest | Chips read | QC |
|---|---|---|---|---|---|---|---|---|
| **HITBOX_SYSTEM_ADMIN** | ✅ every block | ✅ | ✅ | ✅ all | ✅ | ✅ | ✅ | ✅ |
| **HITBOX_DROP_MANAGER** | ✅ no chip blocks | ✅ | ❌ | ✅ all | ❌ | ❌ | ❌ | ❌ |
| **HITBOX_CONTENT_MANAGER** | ❌ | ✅ | ❌ | ✅ all | ❌ | ❌ | ❌ | ❌ |
| **HITBOX_ORDER_MANAGER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **HITBOX_SUPPORT** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **HITBOX_FINANCE_ADMIN** | ⚠️ envelope only | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **BRAND_ADMIN** | ✅ own org only | ❌ | ❌ | ✅ own drops | ❌ | ❌ | ❌ | ❌ |
| **BRAND_EMPLOYEE** | ✅ own org only | ❌ | ❌ | ✅ own drops | ❌ | ❌ | ❌ | ❌ |
| **ARTIST** | ✅ own org only | ❌ | ❌ | ✅ own drops | ❌ | ❌ | ❌ | ❌ |
| **BUYER_COLLECTOR** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **HITBOX_PLATFORM_ENGINEER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **HITBOX_FULL_STACK_ENGINEER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Derived from the grants each role actually holds — no route in this module
reads a role name.

### Three entries that deserve a sentence

**`HITBOX_SUPPORT` reads chips but cannot record QC.** Support holds
`nfc-tag-claim:update:global`, and **`update` is not `manage`** — the two are
separate actions and neither implies the other in `ACTION_IMPLIES`. Support can
change tag state while resolving a case (that is `@hitbox/skus`); recording a
manufacturing QC verdict is an intake operation and needs `manage`.

**⚠️ `HITBOX_FINANCE_ADMIN` gets an empty rollup.** The role holds
`reports-dashboards:read:global` but no `drop` and no `nfc-tag-claim` grant, so
every block inside the response is gated away and what comes back is
`{ generatedAt, scope, organizationIds }` and nothing else. That is the honest
answer to "you may read reports, but you may read no supply data" — it is not a
bug. If Finance should see consignment figures, grant the role
`drop:read:global`; nothing in this module needs changing.

**Technical roles see nothing.** `HITBOX_PLATFORM_ENGINEER` and
`HITBOX_FULL_STACK_ENGINEER` are TECHNICAL-domain roles and every capability
here is BUSINESS-domain. The domain boundary is absolute — see
[authorization-architecture.md](../authorization/authorization-architecture.md).

### What each role sees *inside* the metrics response

Blocks are **absent, never zeroed**. `tags: { total: 0 }` would read as "no
chips exist", which is a different and actionable claim from "you cannot see
this".

| Block | Needs |
|---|---|
| `batches`, `inventory`, `reconciliation.shortfalls`, `lowStock` | `drop:read` at operator grade |
| `vendors` | `drop:read` at **GLOBAL** reach |
| `tags`, `inventory.tagged`, `inventory.untagged`, `reconciliation.unboundTagStock`, `reconciliation.untaggedUnits` | `nfc-tag-claim:read` |

---

## 4. The intake flow, end to end

```
  1. POST /vendors                          register the manufacturer (once)
              │
  2. POST /batches                          book the carton in      → UPLOADED
              │
  3. POST /batches/:id/tags   (dryRun)      preview the manifest
     POST /batches/:id/tags                 register the chips      → NfcTag rows
              │                                                        counters move
  4. POST /batches/:id/decision  VALIDATED  (optional) rows checked
              │
  5. POST /batches/:id/decision  ACCEPTED   take delivery           → terminal
                             or REJECTED    refuse it (note required)
```

### The state machine

```
  UPLOADED ──▶ VALIDATED ──▶ ACCEPTED
     │              │
     └──────────────┴──────▶ REJECTED
```

`ACCEPTED` and `REJECTED` are **terminal**. A consignment accepted in error is
not walked backwards — the stock is physically in the building by then, and
pretending otherwise loses the record that it ever arrived. The correction is a
second consignment with a note, which keeps both facts.

`VALIDATED` may be **skipped**: a small consignment keyed in by hand is checked
by the person keying it.

A transition to the state it is already in is refused, so a double-click is a
`409` rather than a silent re-decision.

### Rows are registered *before* the decision, not after

`acceptsRows()` allows a manifest in `UPLOADED` and `VALIDATED` only. That is
deliberate and is the opposite of what "register into an accepted batch" would
suggest: the rows are registered with the reviewer watching, and the acceptance
decision is then taken **with the registered rows in front of them**.
Appending to an already-accepted consignment would silently change counts
somebody has signed off.

---

## 5. Vendors

### `GET /api/v1/admin/supply/vendors`

Requires `drop:read` at **GLOBAL** reach.

| Query | Type | Notes |
|---|---|---|
| `search` | string | Matches name or legal name, case-insensitive |
| `vendorType` | enum | `NFC_TAG_MANUFACTURER` \| `MERCHANDISE_MANUFACTURER` \| `OTHER`, case-insensitive |
| `country` | string(2) | ISO 3166-1 alpha-2 |
| `isActive` | boolean | |
| `includeArchived` | boolean | Default `false` |
| `page`, `limit` | int | Default `1` / `50`, max `200` |

```json
{
  "data": [
    {
      "id": "b1f2…",
      "name": "Shenzhen ChipWorks",
      "legalName": "Shenzhen ChipWorks Electronics Co., Ltd",
      "country": "CN",
      "vendorType": "NFC_TAG_MANUFACTURER",
      "contactName": "Li Wei",
      "contactEmail": "liwei@chipworks.example",
      "contactPhone": "+86 755 0000 0000",
      "notes": null,
      "isActive": true,
      "archivedAt": null,
      "createdAt": "2026-03-01T09:00:00.000Z",
      "updatedAt": "2026-09-14T11:20:00.000Z",
      "counts": { "batches": 14, "units": 4820 }
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 6, "totalPages": 1 }
}
```

`counts.units` is serialized items traced back to this vendor via
`Sku.vendorId`; `counts.batches` is consignments. Both are live, and both are
what a "safe to retire?" check reads.

### `POST /api/v1/admin/supply/vendors`

Requires `nfc-tag-claim:manage:global`. Returns `201`.

```json
{
  "name": "Shenzhen ChipWorks",
  "legalName": "Shenzhen ChipWorks Electronics Co., Ltd",
  "country": "CN",
  "vendorType": "NFC_TAG_MANUFACTURER",
  "contactEmail": "liwei@chipworks.example",
  "isActive": true
}
```

`name` and `vendorType` are the only required fields. `country` is two
characters because a tag consignment crossing a border is a customs question
before it is a supply one.

### `GET /api/v1/admin/supply/vendors/:vendorId`

Same shape as one list row.

### `PATCH /api/v1/admin/supply/vendors/:vendorId`

Requires `nfc-tag-claim:manage:global`. Every field optional, **at least one
required** — a PATCH that changes nothing is a mistake on the caller's side,
not a no-op worth a `200`.

`archived: true` is the soft-retire switch (sets `archivedAt` **and** clears
`isActive`); `archived: false` clears it. There is deliberately no `DELETE`: a
vendor with consignments against it cannot be removed without removing the
record that those consignments arrived.

---

## 6. Consignments

### `GET /api/v1/admin/supply/batches`

Requires `drop:read` at operator grade. **Organization-scoped**: a brand sees
consignments ordered for their own drops.

| Query | Type | Notes |
|---|---|---|
| `vendorId`, `dropId` | uuid | |
| `status` | enum | `UPLOADED` \| `VALIDATED` \| `ACCEPTED` \| `REJECTED` |
| `itemType` | enum | `NFC_TAG` \| `MERCHANDISE` \| `COLLECTIBLE` |
| `search` | string | Matches `batchRef` or `vendorInvoiceRef` |
| `receivedFrom`, `receivedTo` | ISO date | |
| `page`, `limit` | int | |

```json
{
  "data": [
    {
      "id": "c7a1…",
      "vendorId": "b1f2…",
      "vendor": { "id": "b1f2…", "name": "Shenzhen ChipWorks", "vendorType": "NFC_TAG_MANUFACTURER" },
      "dropId": "d901…",
      "drop": { "id": "d901…", "groupCode": "8417", "name": "Kaze — Ember Series" },
      "itemType": "NFC_TAG",
      "status": "VALIDATED",
      "quantity": 500,
      "batchRef": "CW-2026-0914",
      "vendorInvoiceRef": "INV-88213",
      "receivedAt": "2026-09-14T00:00:00.000Z",
      "batchDate": "2026-09-14T00:00:00.000Z",
      "rowsReceived": 498,
      "rowsAccepted": 495,
      "rowsRejected": 3,
      "sourceFileRef": "manifests/cw-2026-0914.xlsx",
      "validationReportRef": null,
      "enteredById": "u-0f21…",
      "notes": "Two reels short against the packing list.",
      "createdAt": "2026-09-14T10:02:00.000Z",
      "updatedAt": "2026-09-14T10:44:00.000Z",
      "reconciliation": {
        "declared": 500,
        "registered": 498,
        "shortfall": 2,
        "tagsRegistered": 498
      }
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 42, "totalPages": 1 }
}
```

**`reconciliation` is the number the intake screen exists to surface.**
`declared` is what the vendor's paperwork says, `registered` is what was
actually keyed in, and `shortfall` is the gap. `tagsRegistered` — the chip rows
that genuinely exist against this consignment — is present **only** for callers
holding `nfc-tag-claim:read`; it is what catches a manifest counted twice.

#### Consignments with no drop are invisible to a brand

`dropId` is optional: platform chip stock is bought ahead of any particular
drop. A consignment with no drop is therefore invisible to an
organization-scoped caller, deliberately — "how much chip stock does HitBox
hold" is not a brand's business. The filter is part of the lookup, so an
out-of-scope id and a non-existent id both return `404`; a different status for
each would let a brand enumerate another brand's consignments.

### `POST /api/v1/admin/supply/batches`

Requires `nfc-tag-claim:manage:global`. Returns `201` with `status: "UPLOADED"`.

```json
{
  "vendorId": "b1f2…",
  "dropId": "d901…",
  "itemType": "NFC_TAG",
  "quantity": 500,
  "batchRef": "CW-2026-0914",
  "vendorInvoiceRef": "INV-88213",
  "receivedAt": "2026-09-14",
  "sourceFileRef": "manifests/cw-2026-0914.xlsx",
  "notes": "Two reels short against the packing list."
}
```

`receivedAt` defaults to now and `batchDate` defaults to `receivedAt`, so a
same-day intake needs neither. `enteredById` is taken from the authenticated
caller and is not settable.

An archived vendor is refused with `409 SUPPLY_VENDOR_ARCHIVED`; an unknown
`dropId` is a `404` naming the drop rather than a foreign-key error naming a
constraint.

### `POST /api/v1/admin/supply/batches/:batchId/decision`

Requires `nfc-tag-claim:manage:global`.

```json
{ "status": "REJECTED", "note": "Seals broken on arrival; refused at the dock." }
```

| Field | Required | Notes |
|---|---|---|
| `status` | ✅ | Must be legal from the current state |
| `note` | **required to reject** | Refusing a consignment becomes a credit note and a conversation with the vendor; "why" is the only part that cannot be reconstructed afterwards |
| `validationReportRef` | | Pointer to the stored validation report |

The note is **appended** to `notes`, prefixed with the decision
(`[REJECTED] …`), so a rejection reason never overwrites the discrepancy that
prompted it.

An illegal transition is `409 SUPPLY_BATCH_STATE_INVALID`.

---

## 7. The chip manifest

### `POST /api/v1/admin/supply/batches/:batchId/tags`

Requires `nfc-tag-claim:manage:global`, **and** the chip-UID key must be
configured on the deployment (see [§13](#13-deployment)).

```json
{
  "dryRun": true,
  "tags": [
    { "uid": "04:A3:9B:2C:5D:6E:80" },
    { "uid": "04A39B2C5D6E81", "qcStatus": "PASSED" },
    { "uid": "04-a3-9b-2c-5d-6e-82", "qcStatus": "FAILED", "qcNotes": "Antenna open circuit." }
  ]
}
```

Up to **1000 rows** per call (`SUPPLY_MANIFEST_MAX`) — matched to a physical
carton, and registered in one transaction. A 10,000-chip consignment arrives as
ten calls.

#### UIDs are normalised

`04:A3:9B:2C:5D:6E:80`, `04-a3-9b-2c-5d-6e-80` and `04a39b2c5d6e80` are the
**same UID**. Separators are stripped, the value is upper-cased, and anything
non-hexadecimal is refused. Without this, the same chip registered from two
differently-formatted vendor files would produce two rows and the uniqueness
guarantee would be worthless.

#### Three refusals, in order

1. **Wrong consignment** — chips only go into an `NFC_TAG` batch that still
   accepts rows, and the declared quantity is a ceiling
   (`409 SUPPLY_BATCH_ITEM_TYPE_INVALID` / `_STATE_INVALID` /
   `_QUANTITY_EXCEEDED`).
2. **The manifest repeats a UID within itself**
   (`400 SUPPLY_TAG_UID_DUPLICATED`).
3. **A UID is already registered anywhere on the platform**
   (`409 SUPPLY_TAG_UID_TAKEN`).

The third is the anti-cloning check. Two rows claiming the same chip is
precisely the state a counterfeit produces, so **the whole manifest is refused
rather than the offending row skipped** — a carton containing one duplicate is
a carton nobody should accept the rest of without looking at it.

Offending rows are identified **by position, never by UID**:

```json
{
  "error": {
    "code": "SUPPLY_TAG_UID_TAKEN",
    "message": "The manifest contains a tag UID that is already registered.",
    "details": {
      "duplicates": [{ "row": 17, "reason": "Already registered on this platform." }]
    }
  }
}
```

#### `dryRun`

Parses and checks the manifest without writing. The response shape is
**identical**, so an intake screen previews a carton and commits the same
payload. `dryRun` defaults to `false` — an unflagged call writes.

```json
{
  "data": {
    "batchId": "c7a1…",
    "dryRun": true,
    "registered": 498,
    "duplicates": [],
    "batch": { "rowsReceived": 498, "rowsAccepted": 495, "rowsRejected": 3, "status": "UPLOADED" }
  }
}
```

#### How the counters move

- `rowsReceived` += every row in the manifest
- `rowsAccepted` += rows whose `qcStatus` is not `FAILED`
- `rowsRejected` += rows whose `qcStatus` **is** `FAILED`

A chip that failed QC was *received*, it was just not *accepted* — which is
exactly what the three counters distinguish. Counters are **incremented, not
assigned**, because a carton arrives as several manifest calls and assigning
would make the last one overwrite the others.

#### Chip codes

Each row gets `nfcTagCode` = `NT` + an 8-digit zero-padded ordinal
(`NT00000001`), allocated **inside the transaction** from the current maximum,
so two concurrent manifests cannot mint the same code. The unique index is the
backstop, and a collision fails the whole batch rather than writing half of it.

The zero-padding is load-bearing, not cosmetic: it makes lexical `ORDER BY`
identical to numeric order, which is how the allocator finds the highest code.

---

## 8. Chip inventory

### `GET /api/v1/admin/supply/tags`

Requires `nfc-tag-claim:read`.

| Query | Type | Notes |
|---|---|---|
| `supplyBatchId`, `vendorId`, `skuId` | uuid | |
| `lifecycleState` | enum | `UNPROVISIONED` \| `BOUND` \| `ACTIVE` \| `LOST` \| `REVOKED` \| `DISPUTED` |
| `qcStatus` | enum | `PENDING` \| `PASSED` \| `FAILED` |
| `unbound` | boolean | `true` = chips not yet in an item, i.e. **free stock** |
| `nfcTagCode` | string | Exact match on the code printed on the reel |
| `page`, `limit` | int | |

```json
{
  "data": [
    {
      "id": "e4c0…",
      "nfcTagCode": "NT00000498",
      "supplyBatchId": "c7a1…",
      "batch": { "id": "c7a1…", "batchRef": "CW-2026-0914", "vendorId": "b1f2…", "vendorName": "Shenzhen ChipWorks" },
      "skuId": "9b12…",
      "sku": { "id": "9b12…", "skuCode": "8417-000014", "serialNumber": 14 },
      "qcStatus": "PASSED",
      "qcReportedAt": "2026-09-14T10:40:00.000Z",
      "qcNotes": null,
      "lifecycleState": "BOUND",
      "lastTapCounter": 0,
      "tamperStatus": null,
      "personalizedAt": null,
      "boundAt": "2026-09-16T08:11:00.000Z",
      "activatedAt": null,
      "retiredAt": null,
      "createdAt": "2026-09-14T10:33:00.000Z",
      "updatedAt": "2026-09-16T08:11:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 12400, "totalPages": 248 }
}
```

**There is no `uid` field, and no capability adds one.** See [§10](#10-tag-uid-handling).

### `GET /api/v1/admin/supply/tags/:tagId`

Same shape, one row.

### `PATCH /api/v1/admin/supply/tags/:tagId/qc`

Requires `nfc-tag-claim:manage:global`.

```json
{ "qcStatus": "FAILED", "qcNotes": "Fails read at 4cm; antenna suspect." }
```

Sets `qcReportedAt` to now. A body recording the verdict already on the row is
`400 SUPPLY_NO_CHANGES`.

**The consignment's counters are deliberately not moved.** `rowsAccepted` /
`rowsRejected` record what the *manifest* said on intake; a later QC reversal is
a fact about the chip, and rewriting the intake counters would change a figure
an acceptance decision was already taken against.

#### This is not how a chip is bound to an item

Binding a chip into a `Sku` is `@hitbox/skus`
(`PATCH /admin/skus/:skuId/tag` and `POST /admin/products/:productId/skus/tags`
— see [sku-api.md](sku-api.md)). Registering a chip into inventory and
embedding it in a unit are separate operations with separate rules, and this
module does only the first.

---

## 9. Supply & inventory metrics

### `GET /api/v1/admin/supply/metrics`

Requires `reports-dashboards:read`.

| Query | Type | Notes |
|---|---|---|
| `organizationId` | uuid | **Narrows only.** Naming an organization you hold nothing for is `403`, not an empty result — an empty result would let you probe which organizations exist by watching response shapes |
| `vendorId` | uuid | Confines the chip and consignment blocks |
| `receivedFrom`, `receivedTo` | ISO date | Confines the consignment and vendor blocks to a receipt window |

A full response, as `HITBOX_SYSTEM_ADMIN` sees it:

```json
{
  "data": {
    "generatedAt": "2026-09-28T07:44:00.000Z",
    "scope": "GLOBAL",
    "organizationIds": null,

    "tags": {
      "total": 12400,
      "byLifecycle": { "UNPROVISIONED": 4000, "BOUND": 6000, "ACTIVE": 2350, "LOST": 20, "REVOKED": 25, "DISPUTED": 5 },
      "byQc": { "PENDING": 100, "PASSED": 12250, "FAILED": 50 },
      "qcFailureRate": "0.40",
      "unbound": 4000,
      "bound": 8400
    },

    "batches": {
      "total": 42,
      "byStatus": { "UPLOADED": 3, "VALIDATED": 2, "ACCEPTED": 36, "REJECTED": 1 },
      "byItemType": { "NFC_TAG": 20, "MERCHANDISE": 15, "COLLECTIBLE": 7 },
      "quantityDeclared": 15000,
      "rowsReceived": 14950,
      "rowsAccepted": 14800,
      "rowsRejected": 150,
      "acceptanceRate": "98.99",
      "pendingReview": 5
    },

    "vendors": {
      "active": 6,
      "byType": { "NFC_TAG_MANUFACTURER": 3, "MERCHANDISE_MANUFACTURER": 2, "OTHER": 1 },
      "leaders": [
        {
          "vendorId": "b1f2…",
          "name": "Shenzhen ChipWorks",
          "vendorType": "NFC_TAG_MANUFACTURER",
          "batches": 14,
          "quantityDeclared": 7000,
          "rowsAccepted": 6890,
          "rowsRejected": 110,
          "rejectionRate": "1.57"
        }
      ]
    },

    "inventory": {
      "drops": 12,
      "totalSupply": 5000,
      "minted": 4200,
      "unminted": 800,
      "claimed": 1200,
      "unclaimed": 3000,
      "tagged": 3900,
      "untagged": 300
    },

    "reconciliation": {
      "shortfalls": [
        {
          "batchId": "c7a1…",
          "batchRef": "CW-2026-0914",
          "vendorName": "Shenzhen ChipWorks",
          "declared": 500,
          "registered": 498,
          "shortfall": 2
        }
      ],
      "unboundTagStock": 4000,
      "untaggedUnits": 300
    },

    "lowStock": [
      {
        "productId": "d901…",
        "groupCode": "8417",
        "name": "Kaze — Ember Series",
        "totalSupply": 500,
        "minted": 480,
        "remaining": 20,
        "percentRemaining": "4.00"
      }
    ]
  }
}
```

### Reading it

| Block | The question it answers |
|---|---|
| `tags` | Where is the chip stock in its lifecycle, and how many chips are still free? |
| `batches` | How much has been received, how much accepted, how much is awaiting a decision? |
| `vendors` | Whose cartons keep failing? `leaders` is ranked by **rows rejected**, not by size — the list exists to surface the unreliable vendor, not the biggest one |
| `inventory` | Declared supply against what is actually minted, tagged and claimed |
| `reconciliation` | Where the paperwork and the shelf disagree |
| `lowStock` | Which drops are within 10% of exhausting their unminted supply |

### Four things about the figures

**Rates are two-decimal strings, never floats.** `"98.99"`, not `98.98666…`.
Same reasoning as money: a client that receives a string cannot accidentally
re-round it into something that disagrees with what another screen shows. A
zero denominator renders `"0.00"`, not `NaN` — "no rows were decided" is a real
state on the intake screen and should render as a number.

**"Remaining" in `lowStock` is unminted units** — supply that exists on paper
but has no serialized row yet. A drop whose units are all minted and all sold is
not low on *supply*; it is sold out, which is a different screen.

**`tagged` counts `Sku.currentNfcTagId`**, the live column. The deprecated
`Sku.tagId` mirrors the same fact and is deliberately not counted, or a
backfilled row would count twice.

**Blocks are omitted, not zeroed** — see [§3](#3-who-can-do-what). Check for the
*presence* of the key, never for a zero value.

### Relationship to `GET /admin/dashboard/supply`

The dashboard's `supply` section still exists and still returns a paginated
consignment list plus an active-vendor count, gated on `drop:read`. It is a
**list**; this is a **rollup**. Neither replaces the other, and both read the
same tables.

---

## 10. Tag UID handling

A chip UID is the platform's anti-counterfeiting secret: whoever holds one can
write it to a blank chip. So:

1. **A raw UID is never stored.** `NfcTag.tagUidHash` is a deterministic
   HMAC-SHA256 lookup key; `tagUidEncrypted` is an AES-256-GCM copy
   (`iv.authTag.ciphertext`, base64, non-deterministic).
2. **A raw UID is never returned.** `NfcTagResponse` has no `uid` field and
   there is no capability that adds one. The repository's `select` names every
   column of `NfcTag` **except** `tagUidHash`, `tagUidEncrypted` and
   `keyReference` — excluded at the read rather than stripped later, so there
   is no code path that can forget to strip what was never read.
3. **A raw UID is never logged.** The service hashes the manifest as its first
   step, so only hashes reach a query, a log line or an error message.
   Duplicate rows are reported **by position**.
4. **A raw UID is never audited.** Intake audit entries carry counts and the
   `keyReference`, never UIDs. An audit trail recording them would be a second
   place the material is stored, and a longer-lived one than the table.
5. **The key belongs to the deployment, not the package.** `ITagCipher` is a
   port implemented at the composition root
   ([`apps/backend/src/adapters/tag-cipher.ts`](../../apps/backend/src/adapters/tag-cipher.ts)).
   A module deriving its own key would have that key in the repository.

---

## 11. Errors

Standard envelope:

```json
{ "error": { "code": "SUPPLY_BATCH_STATE_INVALID", "message": "…", "details": null } }
```

| Code | Status | Meaning |
|---|---|---|
| `SUPPLY_FORBIDDEN` | 403 | No operator-grade grant for this surface |
| `SUPPLY_VENDOR_NOT_FOUND` | 404 | |
| `SUPPLY_BATCH_NOT_FOUND` | 404 | Also returned for a consignment outside your organizations |
| `SUPPLY_TAG_NOT_FOUND` | 404 | |
| `SUPPLY_NOT_FOUND` | 404 | Unknown `dropId` on consignment creation |
| `SUPPLY_VENDOR_ARCHIVED` | 409 | An archived vendor cannot take new consignments |
| `SUPPLY_BATCH_STATE_INVALID` | 409 | Illegal transition, or rows into a decided consignment |
| `SUPPLY_BATCH_ITEM_TYPE_INVALID` | 409 | Chips into a non-`NFC_TAG` consignment |
| `SUPPLY_BATCH_QUANTITY_EXCEEDED` | 409 | Manifest would exceed the declared quantity |
| `SUPPLY_TAG_UID_TAKEN` | 409 | A UID is already registered platform-wide |
| `SUPPLY_TAG_UID_DUPLICATED` | 400 | The manifest repeats a UID within itself |
| `SUPPLY_NO_CHANGES` | 400 | A body that would change nothing |
| `SUPPLY_TAG_KEY_UNAVAILABLE` | 503 | No chip-UID key configured on this deployment |

---

## 12. The audit trail

Every write is recorded through `ISupplyAudit`, **awaited and allowed to
throw**. Taking delivery of 5,000 chips is the moment the platform becomes
accountable for them, so an intake write whose audit row failed fails with it
rather than succeeding quietly.

| Event key | Records |
|---|---|
| `supply.vendor.create` | Name, type, country |
| `supply.vendor.update` | **Field names only**, never their values |
| `supply.batch.create` | Vendor, item type, quantity, batch reference |
| `supply.batch.decide` | Before/after status, and the note |
| `supply.tags.register` | Row count and `keyReference` — **never UIDs** |
| `supply.tag.qc` | Before/after QC status |

Each carries the request's `correlationId` (falling back to a fresh UUID if the
correlation middleware is not mounted — a row with a fresh id is still a row,
whereas one that threw is a lost intake record).

---

## 13. Deployment

### `NFC_TAG_UID_KEY` — required to register chips

```bash
NFC_TAG_UID_KEY=<at least 32 characters of high-entropy secret>
NFC_TAG_KEY_REFERENCE=env:v1   # optional; names the key in force
```

Generate one with:

```bash
openssl rand -hex 32
```

Unlike `IP_HASH_SALT` this **has no fallback**, and that is deliberate. Absent:

- every **read** route works normally;
- `POST /batches/:id/tags` answers **`503 SUPPLY_TAG_KEY_UNAVAILABLE`**.

Rows written under an improvised key can never be matched against a real tap in
the field, so a deployment without the key must refuse to write them rather than
write ones that look fine until the first scan.

The value is hashed to 32 bytes, so it may be hex, base64 or a passphrase —
the operator does not have to know which the cipher wanted. **Never commit it.**

Rotating the key changes `NfcTag.keyReference`, so rows written under the old
one stay identifiable. Existing rows are **not** re-encrypted by a rotation;
that is a migration, not a config change.

### No schema migration

This module adds no tables and no columns. `Vendor`, `SupplyBatch` and `NfcTag`
already existed (v3.1); what was missing was every layer above them.

### Restart required

`@hitbox/supply` is a new workspace package. `pnpm start` has no watch mode, so
a running dev server must be restarted or the routes answer `404`.

---

## 14. Not built

| Gap | Note |
|---|---|
| Spreadsheet upload | The manifest arrives as JSON. `sourceFileRef` stores a pointer to the vendor's file, but nothing parses XLSX/CSV server-side — that conversion is the console's job today |
| Automatic chip→unit binding | Registering inventory and binding a chip to a `Sku` stay separate operations in separate modules, by design |
| Merchandise item rows | A `MERCHANDISE` consignment records a quantity, not a row per garment. Only `NFC_TAG` consignments get per-item rows |
| Reopening a decided consignment | `ACCEPTED`/`REJECTED` are terminal. The correction is a second consignment |
| Purchase orders / costs | No PO model and no cost per unit. `vendorInvoiceRef` is a free-text pointer; landed cost lives in `CogsReconciliation`, which nothing writes yet |
| Vendor scorecard over time | `vendors.leaders` is a snapshot over the queried window; there is no trend series |
| CSV export | `reports-dashboards:export:global` exists in the catalog and nothing consumes it here either |
| Low-stock alerting | `lowStock` is computed on read. No job, no notification — the threshold is `LOW_STOCK_THRESHOLD` (10%) and is not configurable per drop |
