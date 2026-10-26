# Vendor Administration API — admin console

How HitBox staff decide **who** can sign in for a vendor and **which drops**
that vendor may supply.

Base path: `/api/v1/admin/supply/vendors/:vendorId`
Module: `@hitbox/supply`
Owns: `VendorMember`, `VendorDropAssignment`, `VendorVariantAllotment`

The end-to-end story is in [vendor-onboarding-flow.md](vendor-onboarding-flow.md).
Creating/editing the vendor record itself is unchanged —
[admin/supply-inventory-api.md §5](../admin/supply-inventory-api.md#5-vendors).

---

## Contents

1. [Endpoints at a glance](#1-endpoints-at-a-glance)
2. [Who can call this](#2-who-can-call-this)
3. [Invite a vendor user](#3-invite-a-vendor-user)
4. [List and revoke members](#4-list-and-revoke-members)
5. [Drop assignments and variant allotments](#5-drop-assignments-and-variant-allotments)
6. [Errors](#6-errors)
7. [Audit trail and events](#7-audit-trail-and-events)

---

## 1. Endpoints at a glance

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/vendors/:vendorId/members` | List the vendor's portal users |
| `POST` | `/vendors/:vendorId/members` | Invite someone to sign in for this vendor |
| `POST` | `/vendors/:vendorId/members/:memberId/revoke` | Revoke a member (or withdraw a pending invite) |
| `GET` | `/vendors/:vendorId/drops` | Drops this vendor may supply |
| `POST` | `/vendors/:vendorId/drops` | Assign a drop with its allotment (per variant) |
| `PUT` | `/vendors/:vendorId/drops/:dropId/allotment` | Replace the whole allotment |
| `PATCH` | `/vendors/:vendorId/drops/:dropId/allotment` | Raise/lower specific variants (or the drop quantity) — "increase total supply" |
| `DELETE` | `/vendors/:vendorId/drops/:dropId` | Unassign a drop |

---

## 2. Who can call this

Every route requires **`nfc-tag-claim:manage` at GLOBAL scope** — the same
gate as every other supply write (`globalOnly`). In the seeded catalog that is
**HITBOX_SYSTEM_ADMIN** only.

- The member list is gated on the write capability too, not `drop:read`: it
  exposes invitees' email addresses.
- Inviting does not additionally require `employee-role-mgmt:assign`. The role
  it grants (`VENDOR`) holds only `:own` permissions, which the
  no-escalation check treats as always grantable.

Anyone else gets `403 SUPPLY_FORBIDDEN` (or the guard's 403).

---

## 3. Invite a vendor user

### `POST /api/v1/admin/supply/vendors/:vendorId/members`

**Body** — all optional:

| Field | Type | Notes |
|---|---|---|
| `email` | string (email) | Defaults to the vendor's `contactEmail`. Lower-cased. `""` counts as absent. |

An empty body (`{}`) invites the vendor's contact person.

**What happens**

1. Vendor must exist, not be archived, and be `isActive`.
2. Address must not already have a live (INVITED/ACTIVE) membership — at this
   vendor (`SUPPLY_VENDOR_MEMBER_EXISTS`) or any other
   (`SUPPLY_VENDOR_MEMBER_OTHER_VENDOR`). Checked **before** anything is sent.
3. A staff invitation for the `VENDOR` role (scope `OWN`) is created through
   access-control — the same machinery as `POST /admin/authz/invitations`.
4. A `VendorMember` row is written, linked to that invitation.

**`201` response**

```json
{
  "data": {
    "outcome": "INVITATION_SENT",
    "member": {
      "id": "3f1c…",
      "vendorId": "9a2e…",
      "email": "li.wei@szfigures.example",
      "status": "INVITED",
      "userId": null,
      "invitationId": "c0d4…",
      "invitedById": "a11d…",
      "invitedAt": "2026-10-25T09:12:00.000Z",
      "acceptedAt": null,
      "revokedAt": null,
      "revokeReason": null
    },
    "invitationExpiresAt": "2026-10-28T09:12:00.000Z"
  }
}
```

| `outcome` | Meaning | `member.status` |
|---|---|---|
| `INVITATION_SENT` | Clerk emailed a sign-up link. Status turns `ACTIVE` when they sign up. | `INVITED` |
| `ROLE_ASSIGNED` | The address already had an account; role granted immediately, no email. | `ACTIVE` |

> The pending invitation also shows on the generic Team → Invitations screen
> (`GET /admin/authz/invitations`) with role `VENDOR`. Revoke vendor invites
> **here**, not there, so the membership closes too.

---

## 4. List and revoke members

### `GET /api/v1/admin/supply/vendors/:vendorId/members`

| Query | Notes |
|---|---|
| `status` | Optional: `INVITED`, `ACTIVE`, `REVOKED` (any case) |

```json
{ "data": [ { …member… }, … ] }
```

Newest invitation first. Not paginated — a vendor has a handful of users.

### `POST /api/v1/admin/supply/vendors/:vendorId/members/:memberId/revoke`

```json
{ "reason": "Left the company" }
```

`reason` is required (1–500 chars).

- `ACTIVE` member → `REVOKED`; their portal access ends on the next request.
- `INVITED` member → `REVOKED`, and the pending staff invitation is withdrawn
  (at Clerk too). If Clerk can't be reached the membership is still revoked —
  a later sign-up would get a role with no membership, which reaches nothing.
- Already `REVOKED` → `409 SUPPLY_VENDOR_MEMBER_EXISTS`.

Returns `200 { "data": { …member… } }`. Revoking frees the account to be invited
again (to this or another vendor).

---

## 5. Drop assignments and variant allotments

A vendor user can book consignments and upload manifests **only** for drops
assigned here, and only up to the **allotment** set here. Staff routes are not
limited by assignments or allotments.

### Allotment follows the drop's variants

The NFC chip is embedded in the goods, and goods come in variants. So a drop
with variants is allotted **per variant**:

> Red T-shirt drop, 300 units → **Red / S: 100 · Red / M: 100 · Red / L: 100**

| Drop has live variants? | Send | Meaning |
|---|---|---|
| **Yes** | `variants: [{ variantId, quantity }]` — **required** | Vendor may supply only these variants, up to each quantity. Drop total = sum. |
| **No** | `quantity` — optional | Drop-level cap. Omit (or `null`) for no cap. |

Sending the wrong shape is `400 SUPPLY_ALLOTMENT_SHAPE_INVALID` (its `details`
lists the drop's variants when you forgot them). Variant ids come from the drop
(`GET /admin/products/:id` → its variants); a variant that is archived,
inactive, or another drop's is `400 SUPPLY_VARIANT_INVALID`.

### Booking may exceed the allotment — accepting may not

- A vendor **can book more** than its allotment (e.g. 120 Red/S against 100).
  The factory shipped what it shipped; the booking records it.
- HitBox **cannot ACCEPT** a consignment while the vendor's accepted units for
  a variant — this consignment included — would exceed that variant's
  allotment. To take the extra stock, the admin first raises the allotment
  with `PATCH …/allotment` (§ below), then accepts. Rejecting is never blocked.
- For a drop with variants the vendor must always say how many of **each
  variant** a consignment holds (`lines`); the check is per variant.

| Term | Means |
|---|---|
| **booked** | Units in this vendor's consignments for the drop that are not `REJECTED` (a rejected carton frees its allotment) |
| **approved** | Units in consignments HitBox has `ACCEPTED` — what the allotment must cover |

### `GET /api/v1/admin/supply/vendors/:vendorId/drops`

```json
{
  "data": [
    {
      "id": "5b7e…",
      "vendorId": "9a2e…",
      "dropId": "d41f…",
      "drop": { "id": "d41f…", "groupCode": "DRP-0042", "name": "Red Logo Tee", "status": "APPROVED" },
      "assignedById": "a11d…",
      "assignedAt": "2026-10-25T09:20:00.000Z",
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

| Field | Meaning |
|---|---|
| `allotted` | What the vendor is to supply. `null` = no cap (drop without variants, no quantity). |
| `booked` | Units in non-rejected consignments (may exceed `allotted`) |
| `approved` | Units in ACCEPTED consignments |
| `overBooked` | `booked − allotted`, never negative — needs an allotment increase before it can all be accepted |

Drop-level `progress` compares totals only (300 allotted vs 180 booked → nothing
over), so always read the per-variant rows: Red/M above is 20 over even though
the drop as a whole is not.
| `registered` | Chips registered against those consignments |
| `accepted` | Of those, not failed QC |
| `remaining` | `allotted − booked`, never negative; `null` when uncapped |

For a drop without variants `byVariant` is `false`, `variants` is `[]` and
`progress` carries the drop-level figures. A variant the vendor booked without
having an allotment for it is listed too, with `allotted: 0` and `variantCode`
/ `label` / `options` as `null`.

### `POST /api/v1/admin/supply/vendors/:vendorId/drops`

Drop with variants:

```json
{
  "dropId": "d41f…",
  "variants": [
    { "variantId": "v1…", "quantity": 100 },
    { "variantId": "v2…", "quantity": 100 },
    { "variantId": "v3…", "quantity": 100 }
  ]
}
```

Drop without variants:

```json
{ "dropId": "a77c…", "quantity": 500 }
```

| Result | When |
|---|---|
| `201 { data: assignment }` | Assigned (same shape as the list item) |
| `400 SUPPLY_ALLOTMENT_SHAPE_INVALID` | `variants` missing for a drop with variants, or sent for one without |
| `400 SUPPLY_VARIANT_INVALID` | A variant isn't a live variant of this drop |
| `404 SUPPLY_NOT_FOUND` | No such drop |
| `409 SUPPLY_DROP_ALREADY_ASSIGNED` | Already assigned — use `PUT …/allotment` |
| `409 SUPPLY_VENDOR_ARCHIVED` / `SUPPLY_VENDOR_INACTIVE` | Vendor closed |

Several vendors may be assigned the same drop — e.g. one makes S/M, another L.

### `PUT /api/v1/admin/supply/vendors/:vendorId/drops/:dropId/allotment`

**Replaces** the allotment. Same body as above without `dropId`. Variants left
out are removed.

```json
{ "variants": [ { "variantId": "v1…", "quantity": 120 }, { "variantId": "v2…", "quantity": 100 } ] }
```

Refused with `409 SUPPLY_ALLOTMENT_BELOW_ACCEPTED` if any variant would end up
below what HitBox has already **accepted** (removing a variant counts as 0) —
`details.variants[]` = `{ variantId, accepted, requested }`. Going below
merely *booked* units is allowed. Returns `200 { data: assignment }`.

### `PATCH /api/v1/admin/supply/vendors/:vendorId/drops/:dropId/allotment`

**Increase (or adjust) the total supply** without restating everything.
Variants sent are set to the given quantity — added if new — and every other
variant keeps its allotment.

```json
{ "variants": [ { "variantId": "<Red/S>", "quantity": 120 } ] }
```

Red/S 100 → 120; Red/M and Red/L stay at 100; total 300 → 320. For a drop
without variants send `{ "quantity": 600 }` (or `null` to remove the cap).
Same validation and `SUPPLY_ALLOTMENT_BELOW_ACCEPTED` rule as `PUT`. Returns
`200 { data: assignment }` with refreshed progress.

### Accepting an over-allotment consignment

`GET /api/v1/admin/supply/batches/:batchId` now includes an `allotment` block
(null when the vendor isn't assigned to the drop — e.g. staff-booked stock):

```json
"allotment": {
  "covered": false,
  "byVariant": true,
  "variants": [
    { "variantId": "<Red/S>", "variantCode": "TEE-RED-S", "label": "Red / S",
      "allotted": 100, "acceptedElsewhere": 100, "thisBatch": 20, "required": 120, "shortBy": 20 },
    { "variantId": "<Red/M>", "variantCode": "TEE-RED-M", "label": "Red / M",
      "allotted": 100, "acceptedElsewhere": 0,   "thisBatch": 50, "required": 50,  "shortBy": 0 }
  ],
  "total": null,
  "suggestedPatch": { "variants": [ { "variantId": "<Red/S>", "quantity": 120 } ] }
}
```

`POST /admin/supply/batches/:batchId/decision` with `"status": "ACCEPTED"` on
such a consignment answers **`409 SUPPLY_ALLOTMENT_INSUFFICIENT`** with that
same block as `details`. The console flow:

Accept also requires a complete chip manifest. Until every line has
`rowsReceived == quantity`, the accept answers `409 SUPPLY_MANIFEST_INCOMPLETE`
(`details.lines[]` = `{ variantId, variantCode, label, quantity, registered, shortfall }`).
A successful accept mints one unit per good chip into the drop and returns
`stock` — see [vendor-onboarding-flow.md, Step 9](vendor-onboarding-flow.md#step-9--hitbox-accepts--units-appear-on-the-drop).

1. Show the short variants (`shortBy > 0`).
2. If the admin agrees to take the stock: `PATCH …/allotment` with
   `suggestedPatch` as the body.
3. Retry the accept.

For a drop without variants (or a staff-booked carton without lines) the check
is drop-level: `variants` is `[]` and `total` carries the figures;
`suggestedPatch` is `{ "quantity": required }` when one number fixes it.

### `DELETE /api/v1/admin/supply/vendors/:vendorId/drops/:dropId`

`204` on success, `404 SUPPLY_DROP_NOT_ASSIGNED` if it wasn't assigned. The
allotment goes with it.

Consignments already booked against the drop are **not** touched — they
describe goods that shipped. The vendor can still see them, but can no longer
upload manifests to them or book new ones for that drop.

---

## 6. Errors

Standard envelope: `{ "error": { "code", "message", "details" } }`.

| Code | Status | Meaning |
|---|---|---|
| `SUPPLY_FORBIDDEN` | 403 | Caller lacks `nfc-tag-claim:manage:global` |
| `SUPPLY_VENDOR_NOT_FOUND` | 404 | |
| `SUPPLY_VENDOR_MEMBER_NOT_FOUND` | 404 | Member id not under this vendor |
| `SUPPLY_NOT_FOUND` | 404 | Unknown `dropId` |
| `SUPPLY_DROP_NOT_ASSIGNED` | 404 | Unassigning a drop that isn't assigned |
| `SUPPLY_VENDOR_EMAIL_REQUIRED` | 400 | No `email` and no `contactEmail` on file |
| `SUPPLY_VENDOR_MEMBER_EXISTS` | 409 | Already invited/active here, or already revoked |
| `SUPPLY_VENDOR_MEMBER_OTHER_VENDOR` | 409 | Address/account already acts for another vendor (`details.vendorId`) |
| `SUPPLY_DROP_ALREADY_ASSIGNED` | 409 | Use `PUT …/allotment` to change it |
| `SUPPLY_ALLOTMENT_SHAPE_INVALID` | 400 | Per-variant vs drop-level allotment doesn't match the drop |
| `SUPPLY_VARIANT_INVALID` | 400 | Variant not a live variant of the drop (`details.invalid`) |
| `SUPPLY_ALLOTMENT_BELOW_ACCEPTED` | 409 | Allotment edit below what's already accepted |
| `SUPPLY_ALLOTMENT_INSUFFICIENT` | 409 | (on `…/decision`) Accepting would exceed the vendor's allotment — `details` is the `allotment` block |
| `SUPPLY_MANIFEST_INCOMPLETE` | 409 | (accept) Not every unit has a chip — `details.lines[].shortfall` |
| `SKUS_NOT_APPROVED` | 409 | (accept) The drop hasn't cleared release approval |
| `PRODUCTS_VARIANT_SUPPLY_EXCEEDED` / `SKUS_VARIANT_SUPPLY_EXCEEDED` | 409 | (accept) A variant's own `totalSupply` would be exceeded |
| `PRODUCTS_VARIANT_INACTIVE` | 409 | (accept) A chip's variant was archived or deactivated since booking |
| `SKUS_SUPPLY_EXCEEDED` | 409 | (accept) The drop's `totalSupply` would be exceeded |
| `SUPPLY_BATCH_STATE_INVALID` | 409 | (accept) Someone decided this consignment meanwhile |
| `SUPPLY_ACCEPT_CONFLICT` | 409 | (accept) Kept colliding with another mint on the drop — retry |
| `SUPPLY_VENDOR_ARCHIVED` | 409 | |
| `SUPPLY_VENDOR_INACTIVE` | 409 | Reactivate the vendor first |
| `SUPPLY_VENDOR_INVITATIONS_UNAVAILABLE` | 503 | `VENDOR` role not seeded (`pnpm db:seed:authz`) or no identity provider |
| `AUTHZ_FORBIDDEN` | 400 | Clerk refused to send the invitation (`details.invitationId` is the FAILED row) |

---

## 7. Audit trail and events

| Audit event | Severity | Recorded with |
|---|---|---|
| `supply.vendor.member.invite` | WARNING | vendor, member status, invitation id, outcome — never the email |
| `supply.vendor.member.revoke` | WARNING | before/after status, reason |
| `supply.vendor.drop.assign` | WARNING | vendor, drop, the allotment (organization = drop's owner) |
| `supply.vendor.drop.allotment` | WARNING | before/after allotment |
| `supply.vendor.drop.unassign` | WARNING | vendor, drop |

Domain events: `supply.vendor.member-invited`, `supply.vendor.member-activated`,
`supply.vendor.member-revoked`, `supply.vendor.drop-assigned`,
`supply.vendor.drop-unassigned`, `supply.vendor.allotment-updated`.
