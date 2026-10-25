# Vendor Portal API — for vendor users

The endpoints a **vendor's own staff** use after signing in: see their vendor,
see the drops HitBox assigned them, book consignments and upload chip
manifests.

Base path: `/api/v1/vendor`
Module: `@hitbox/supply`

> **Who can use it:** accounts holding the `VENDOR` role **and** an `ACTIVE`
> vendor membership — both come from accepting a vendor invitation
> ([vendor-onboarding-flow.md](vendor-onboarding-flow.md)). There is no vendor
> id in any URL or body: the vendor is always the signed-in user's own.

All requests need a Clerk session (`Authorization: Bearer <token>`).

---

## Contents

1. [Endpoints at a glance](#1-endpoints-at-a-glance)
2. [Signing in](#2-signing-in)
3. [`GET /vendor/me`](#3-get-vendorme)
4. [`GET /vendor/drops`](#4-get-vendordrops)
5. [Consignments](#5-consignments)
6. [Chip manifest](#6-chip-manifest)
7. [What a vendor cannot do](#7-what-a-vendor-cannot-do)
8. [Errors](#8-errors)
9. [Frontend checklist](#9-frontend-checklist)

---

## 1. Endpoints at a glance

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/vendor/me` | `vendor-supply:read:own` | My vendor + my membership |
| `GET` | `/vendor/drops` | `vendor-supply:read:own` | Drops I may supply |
| `GET` | `/vendor/batches` | `vendor-supply:read:own` | My vendor's consignments |
| `POST` | `/vendor/batches` | `vendor-supply:create:own` | Book a consignment for an assigned drop |
| `GET` | `/vendor/batches/:batchId` | `vendor-supply:read:own` | One consignment |
| `POST` | `/vendor/batches/:batchId/tags` | `vendor-supply:create:own` | Upload / validate a chip manifest |

---

## 2. Signing in

Vendors sign in through Clerk exactly like every other user — there is no
vendor-specific login endpoint. After sign-in the frontend should:

1. Call `GET /api/v1/authz/me` — if the permissions include
   `vendor-supply:read:own`, show the vendor portal.
2. Call `GET /api/v1/vendor/me` — `403 SUPPLY_VENDOR_MEMBERSHIP_REQUIRED` means
   the account has the role but no active membership (revoked, or invitation
   never linked): show "your access has been removed — contact HitBox".

---

## 3. `GET /vendor/me`

```json
{
  "data": {
    "member": {
      "id": "3f1c…", "vendorId": "9a2e…", "email": "li.wei@szfigures.example",
      "status": "ACTIVE", "userId": "77b0…", "invitationId": "c0d4…",
      "invitedById": "a11d…", "invitedAt": "…", "acceptedAt": "…",
      "revokedAt": null, "revokeReason": null
    },
    "vendor": {
      "id": "9a2e…", "name": "Shenzhen Figures Co", "legalName": null,
      "country": "CN", "vendorType": "FIGURE",
      "contactName": "Li Wei", "contactEmail": "li.wei@szfigures.example",
      "contactPhone": null, "isActive": true
    }
  }
}
```

`vendor.isActive` is `false` when HitBox deactivated or archived the vendor —
the portal stays readable but new supply is refused. Vendors cannot edit their
own vendor record; changes go through HitBox.

---

## 4. `GET /vendor/drops`

Only drops assigned to the caller's vendor, each with **what you are allotted
and how much is left** — per variant when the drop has variants.

```json
{
  "data": [
    {
      "id": "5b7e…", "vendorId": "9a2e…", "dropId": "d41f…",
      "drop": { "id": "d41f…", "groupCode": "DRP-0042", "name": "Red Logo Tee", "status": "APPROVED" },
      "assignedById": "a11d…", "assignedAt": "…",
      "byVariant": true,
      "progress": { "allotted": 300, "booked": 180, "registered": 150, "accepted": 148, "approved": 160, "remaining": 120, "overBooked": 0 },
      "variants": [
        { "variantId": "v1…", "variantCode": "TEE-RED-S", "label": "Red / S", "options": "color=RED|size=S",
          "allotted": 100, "booked": 60, "registered": 50, "accepted": 49, "approved": 60, "remaining": 40, "overBooked": 0 },
        { "variantId": "v2…", "variantCode": "TEE-RED-M", "label": "Red / M", "options": "color=RED|size=M",
          "allotted": 100, "booked": 120, "registered": 100, "accepted": 99, "approved": 100, "remaining": 0, "overBooked": 20 },
        { "variantId": "v3…", "variantCode": "TEE-RED-L", "label": "Red / L", "options": "color=RED|size=L",
          "allotted": 100, "booked": 0, "registered": 0, "accepted": 0, "approved": 0, "remaining": 100, "overBooked": 0 }
      ]
    }
  ]
}
```

- `booked` counts your consignments that are not `REJECTED`; a rejected carton
  gives its allotment back.
- `remaining` is what is left within your allotment. `null` means no cap.
- `overBooked` is how far you have booked **beyond** it. That is allowed, but
  HitBox can only accept the extra after raising your allotment.
- `approved` is what HitBox has accepted so far.
- `byVariant: false` → a drop without variants: book it with a plain
  `quantity`, `variants` is `[]`.

Use `dropId` and the `variantId`s from here when booking.

---

## 5. Consignments

A consignment (supply batch) is one shipment of goods for one drop. It starts
`UPLOADED`; HitBox moves it to `VALIDATED`, `ACCEPTED` or `REJECTED`.

For a drop allotted by variant a consignment is **split into lines, one per
variant** — e.g. a carton of 100 S + 100 M + 100 L. Each line is checked
against that variant's allotment — booking beyond it is allowed and flagged
(see `allotment` in the response), but HitBox must raise your allotment before
it can accept the extra.

### `GET /vendor/batches`

| Query | Notes |
|---|---|
| `dropId` | Filter to one drop |
| `status` | `UPLOADED` · `VALIDATED` · `ACCEPTED` · `REJECTED` |
| `itemType` | e.g. `FIGURE` |
| `search` | Matches `batchRef` / `vendorInvoiceRef` |
| `receivedFrom`, `receivedTo` | ISO dates |
| `page`, `limit` | Default 1 / 50, max limit 200 |

```json
{
  "data": [ { …consignment… } ],
  "meta": { "page": 1, "limit": 50, "total": 3, "totalPages": 1 }
}
```

Only the caller's vendor's consignments — including ones booked by HitBox staff
for this vendor, and ones for drops since unassigned.

### `GET /vendor/batches/:batchId`

`{ "data": { …consignment… } }`. Another vendor's batch id is `404`.

### `POST /vendor/batches`

**Drop allotted by variant** — send `lines`:

```json
{
  "dropId": "d41f…",
  "itemType": "APPAREL",
  "lines": [
    { "variantId": "v1…", "quantity": 100 },
    { "variantId": "v2…", "quantity": 100 },
    { "variantId": "v3…", "quantity": 100 }
  ],
  "batchRef": "SZ-2026-114"
}
```

**Drop without variants** — send `quantity`:

```json
{ "dropId": "a77c…", "itemType": "FIGURE", "quantity": 500 }
```

| Field | Required | Notes |
|---|---|---|
| `dropId` | ✅ | Must be one of `GET /vendor/drops` |
| `itemType` | ✅ | `FIGURE` `KEYCHAIN` `JERSEY` `APPAREL` `TRADING_CARD` `POSTER` `PLUSH` `MERCHANDISE` `OTHER` |
| `lines` | for a by-variant drop | `[{ variantId, quantity }]` — how many of **each** variant this shipment holds. Any live variant of the drop; may exceed `remaining`. |
| `quantity` | for a drop without variants | 1 – 1,000,000. With `lines` it is optional and, if sent, must equal their sum. |
| `batchRef` | | Your batch label (≤100) — what's printed on the carton |
| `receivedAt` | | ISO date, defaults to now |
| `batchDate` | | ISO date, defaults to `receivedAt` |
| `vendorInvoiceRef` | | Your invoice number (≤100) |
| `sourceFileRef` | | Media reference of an uploaded file (≤500) |
| `notes` | | ≤2000 |

`vendorId` is not accepted — it is always your own vendor.

**Refusals**

| Code | When |
|---|---|
| `403 SUPPLY_DROP_NOT_ASSIGNED` | Drop not assigned to you |
| `400 SUPPLY_ALLOTMENT_SHAPE_INVALID` | `quantity` for a by-variant drop, or `lines` for one without |
| `400 SUPPLY_VARIANT_INVALID` | A line's variant is not a live variant of the drop |

Going over your allotment is **not** refused. The response's `allotment`
block (below) shows whether HitBox could accept this consignment as things
stand: `covered: false` means HitBox has to raise your allotment first.

**`201`**

```json
{
  "data": {
    "id": "b8c2…", "vendorId": "9a2e…",
    "vendor": { "id": "9a2e…", "name": "Shenzhen Apparel Co", "vendorType": "APPAREL" },
    "dropId": "d41f…", "drop": { "id": "d41f…", "groupCode": "DRP-0042", "name": "Red Logo Tee" },
    "itemType": "APPAREL", "status": "UPLOADED", "quantity": 300,
    "batchRef": "SZ-2026-114", "vendorInvoiceRef": null,
    "receivedAt": "…", "batchDate": "…",
    "rowsReceived": 0, "rowsAccepted": 0, "rowsRejected": 0,
    "sourceFileRef": null, "validationReportRef": null,
    "enteredById": "77b0…", "notes": null, "createdAt": "…", "updatedAt": "…",
    "lines": [
      { "variantId": "v1…", "variantCode": "TEE-RED-S", "label": "Red / S", "quantity": 100,
        "rowsReceived": 0, "rowsAccepted": 0, "rowsRejected": 0, "shortfall": 100 },
      { "variantId": "v2…", "variantCode": "TEE-RED-M", "label": "Red / M", "quantity": 100,
        "rowsReceived": 0, "rowsAccepted": 0, "rowsRejected": 0, "shortfall": 100 },
      { "variantId": "v3…", "variantCode": "TEE-RED-L", "label": "Red / L", "quantity": 100,
        "rowsReceived": 0, "rowsAccepted": 0, "rowsRejected": 0, "shortfall": 100 }
    ],
    "reconciliation": { "declared": 300, "registered": 0, "shortfall": 300, "tagsRegistered": 0 },
    "allotment": {
      "covered": true, "byVariant": true,
      "variants": [
        { "variantId": "v1…", "variantCode": "TEE-RED-S", "label": "Red / S",
          "allotted": 100, "acceptedElsewhere": 0, "thisBatch": 100, "required": 100, "shortBy": 0 },
        …
      ],
      "total": null, "suggestedPatch": null
    }
  }
}
```

`allotment` also appears on `GET /vendor/batches/:batchId`. Per variant:
`acceptedElsewhere` = your other accepted units, `required` = that plus this
consignment, `shortBy` = how much your allotment would need to grow for HitBox
to accept it.

`quantity` is the sum of the lines. `lines` is `[]` for a drop without variants.

---

## 6. Chip manifest

### `POST /vendor/batches/:batchId/tags`

Registers the NFC chip inside every product of the consignment: one row per
product, matching the consignment's numbers. Same validation as the staff
route ([admin/supply-inventory-api.md §7](../admin/supply-inventory-api.md#7-the-chip-manifest)).

**When:** only after HitBox has set the consignment to **VALIDATED**. Until
then a real upload answers `409 SUPPLY_BATCH_NOT_VALIDATED`. A `dryRun: true`
check works at any time, so the file can be checked early.

### The CSV the vendor prepares

The API takes JSON. The portal parses a CSV file in the browser and sends JSON.

**Drop with variants** — [examples/chip-manifest-red-tee.csv](examples/chip-manifest-red-tee.csv),
for a consignment of Red/S 3 · Red/M 3 · Red/L 3:

```csv
uid,variant_code,qc_status,qc_notes
04:A1:B2:C3:D4:E5:01,TEE-RED-S,PASSED,
04:A1:B2:C3:D4:E5:02,TEE-RED-S,PASSED,
04:A1:B2:C3:D4:E5:03,TEE-RED-S,PASSED,
04A1B2C3D4E504,TEE-RED-M,PASSED,
04A1B2C3D4E505,TEE-RED-M,PASSED,
04A1B2C3D4E506,TEE-RED-M,FAILED,antenna cracked during heat press
04-A1-B2-C3-D4-E5-07,TEE-RED-L,PASSED,
04-A1-B2-C3-D4-E5-08,TEE-RED-L,,
04-A1-B2-C3-D4-E5-09,TEE-RED-L,PENDING,re-test on arrival
```

**Drop without variants** — [examples/chip-manifest-figure-no-variants.csv](examples/chip-manifest-figure-no-variants.csv):

```csv
uid,qc_status,qc_notes
04F00D0000A001,PASSED,
04F00D0000A002,PASSED,
04F00D0000A003,PASSED,
04F00D0000A004,FAILED,no response at 2cm
04F00D0000A005,PASSED,
```

| Column | Required | Rules |
|---|---|---|
| `uid` | ✅ | The chip's hardware UID in hex, 8–64 characters after cleaning. `:`, `-` and spaces are stripped and letters are upper-cased, so `04:a1:b2…`, `04-A1-B2…` and `04A1B2…` are the same chip. Must be unique in the file and across the whole platform. |
| `variant_code` | for a by-variant drop | One of the consignment's `lines[].variantCode`. The portal maps it to `variantId`. Leave the column out for a drop without variants. |
| `qc_status` | | `PASSED` · `FAILED` · `PENDING`. Empty means `PENDING`. **FAILED chips are not turned into units** on accept. |
| `qc_notes` | | ≤ 500 characters |

The number of rows per `variant_code` must not exceed that line's `quantity`.
HitBox can accept only when every line is full (`rowsReceived == quantity`),
counting FAILED rows.

### What the portal sends

The first three CSV rows above become:

```json
{
  "tags": [
    { "uid": "04:A1:B2:C3:D4:E5:01", "variantId": "<id of TEE-RED-S>", "qcStatus": "PASSED" },
    { "uid": "04:A1:B2:C3:D4:E5:02", "variantId": "<id of TEE-RED-S>", "qcStatus": "PASSED" },
    { "uid": "04:A1:B2:C3:D4:E5:03", "variantId": "<id of TEE-RED-S>", "qcStatus": "PASSED" }
  ],
  "dryRun": true
}
```

| Field | Notes |
|---|---|
| `tags[]` | 1 – 1,000 rows per call. Split larger files into several calls. |
| `tags[].uid` | As in the CSV; cleaned by the server |
| `tags[].variantId` | **Required** when the consignment has `lines`, and must be one of them. **Not allowed** when it has none. |
| `tags[].qcStatus` | Optional; default `PENDING` |
| `tags[].qcNotes` | Optional |
| `dryRun` | `true` checks everything and writes nothing. The response has the same shape. |

**All or nothing.** If any row fails, nothing is written. Errors name the
**row number** (1-based, within this call), never the UID.

```json
{
  "data": {
    "batchId": "b8c2…", "dryRun": false, "registered": 9, "duplicates": [],
    "batch": { "rowsReceived": 9, "rowsAccepted": 8, "rowsRejected": 1, "status": "VALIDATED" },
    "lines": [
      { "variantId": "v1…", "quantity": 3, "rowsReceived": 3, "rowsAccepted": 3, "rowsRejected": 0 },
      { "variantId": "v2…", "quantity": 3, "rowsReceived": 3, "rowsAccepted": 2, "rowsRejected": 1 },
      { "variantId": "v3…", "quantity": 3, "rowsReceived": 3, "rowsAccepted": 3, "rowsRejected": 0 }
    ]
  }
}
```

After this the consignment is complete. When HitBox accepts it, **8 units**
(the FAILED chip is left out) are minted into the drop, each bound to its chip.

Allowed only while:
- the consignment is yours and **VALIDATED**,
- its drop is **still** assigned to your vendor,
- the rows don't push it past its declared `quantity`,
- no variant gets more chips than its line's `quantity`.

UIDs are never returned by any endpoint once registered.

---

## 7. What a vendor cannot do

| Action | Who does it |
|---|---|
| Accept / reject a consignment | HitBox (`POST /admin/supply/batches/:id/decision`) |
| Change QC on a chip after registration | HitBox (`PATCH /admin/supply/tags/:id/qc`) |
| See individual chips / the chip inventory | HitBox |
| Supply an unassigned drop | — ask HitBox to assign it |
| Edit the vendor record or invite colleagues | HitBox |

---

## 8. Errors

| Code | Status | Meaning |
|---|---|---|
| guard 403 | 403 | Account lacks the `VENDOR` role |
| `SUPPLY_VENDOR_MEMBERSHIP_REQUIRED` | 403 | No ACTIVE membership (never invited, still pending, or revoked) |
| `SUPPLY_VENDOR_INACTIVE` | 403 | Vendor deactivated/archived — writes refused, reads still work |
| `SUPPLY_DROP_NOT_ASSIGNED` | 403 | Drop not (or no longer) assigned to your vendor |
| `SUPPLY_BATCH_NOT_FOUND` | 404 | Unknown batch, or another vendor's |
| `SUPPLY_BATCH_NOT_VALIDATED` | 409 | Chip upload before HitBox validated the consignment (a dry run is fine) |
| `SUPPLY_BATCH_STATE_INVALID` | 409 | Consignment already ACCEPTED/REJECTED |
| `SUPPLY_BATCH_QUANTITY_EXCEEDED` | 409 | Manifest would exceed declared quantity |
| `SUPPLY_ALLOTMENT_SHAPE_INVALID` | 400 | `quantity` vs `lines` doesn't match your allotment |
| `SUPPLY_VARIANT_INVALID` | 400 | Line names a variant that isn't a live variant of the drop |
| `SUPPLY_VARIANT_REQUIRED` | 400 | Manifest row without `variantId` on a split consignment (`details.rows`) |
| `SUPPLY_VARIANT_NOT_IN_BATCH` | 400 | Row's variant isn't one of the batch's lines, or the batch has no lines (`details.rows`) |
| `SUPPLY_LINE_QUANTITY_EXCEEDED` | 409 | More chips on a variant than its line declares (`details.lines`) |
| `SUPPLY_TAG_UID_TAKEN` | 409 | A UID is already registered on the platform (`details.duplicates[].row`) |
| `SUPPLY_TAG_UID_DUPLICATED` | 400 | The manifest repeats a UID (`details.duplicates[].row`) |
| `SUPPLY_TAG_KEY_UNAVAILABLE` | 503 | Chip registration not configured on this deployment |
| `VALIDATION_ERROR` | 422 | Body/query failed validation |

---

## 9. Frontend checklist

- [ ] Route vendor users by `vendor-supply:read:own` in `GET /authz/me`.
- [ ] Handle `SUPPLY_VENDOR_MEMBERSHIP_REQUIRED` with an "access removed" screen.
- [ ] Drop picker on "New consignment" is fed only by `GET /vendor/drops`.
- [ ] For `byVariant` drops, render one quantity input per allotted variant
      (pre-fill with `remaining`) and send `lines`; otherwise a single `quantity`.
- [ ] Warn — don't block — when a line exceeds `remaining`; after booking, show
      "awaiting allotment increase" while `allotment.covered` is `false`.
- [ ] Manifest CSV needs a variant column (variantCode is friendliest) — map it
      to `variantId` from the consignment's `lines` before sending.
- [ ] Manifest upload: parse CSV client-side → `dryRun: true` → show row errors
      from `details.duplicates` → resubmit with `dryRun: false`. Enable the
      real upload only when the consignment `status` is `VALIDATED`.
- [ ] Offer the example CSV templates from `docs/vendor/examples/` as downloads.
- [ ] Chunk manifests above 1,000 rows.
- [ ] Disable writes when `vendor.isActive` is `false`.

Audit: vendor writes are recorded as `supply.batch.create` /
`supply.tags.register` with actor type **`VENDOR`**.
