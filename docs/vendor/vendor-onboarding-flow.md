# Vendor Onboarding — End to End

From "we have a new factory" to "their chips are accepted into stock".

All paths are under **`/api/v1`** and need a Clerk session
(`Authorization: Bearer <token>`).

---

## Contents

1. [Who does what](#1-who-does-what)
2. [Step by step](#2-step-by-step)
3. [How sign-up works (the password step)](#3-how-sign-up-works-the-password-step)
4. [Membership states](#4-membership-states)
5. [Edge cases](#5-edge-cases)
6. [Deployment checklist](#6-deployment-checklist)

---

## 1. Who does what

| Actor | Needs | Does |
|---|---|---|
| **System Admin** | `nfc-tag-claim:manage:global` (HITBOX_SYSTEM_ADMIN holds it) | Creates the vendor, invites its users, assigns drops, accepts/rejects consignments |
| **Vendor user** | The `VENDOR` role + an ACTIVE vendor membership (both come from the invitation) | Books consignments and uploads chip manifests for assigned drops |

The `VENDOR` role holds exactly two permissions — `vendor-supply:read:own` and
`vendor-supply:create:own` — and nothing else. It does not reach the admin
console, the chip inventory, other vendors, or any drop it was not assigned.

---

## 2. Step by step

### Step 1 — Admin creates the vendor *(existing API)*

```http
POST /api/v1/admin/supply/vendors
{ "name": "Shenzhen Figures Co", "vendorType": "FIGURE", "country": "CN",
  "contactName": "Li Wei", "contactEmail": "li.wei@szfigures.example" }
```

See [admin/supply-inventory-api.md §5](../admin/supply-inventory-api.md#5-vendors).

### Step 2 — Admin invites the vendor's user

```http
POST /api/v1/admin/supply/vendors/:vendorId/members
{ "email": "li.wei@szfigures.example" }      ← optional; defaults to contactEmail
```

Two outcomes:

| `outcome` | When | Member status |
|---|---|---|
| `INVITATION_SENT` | The address has no HitBox account yet. Clerk emails a sign-up link. | `INVITED` |
| `ROLE_ASSIGNED` | The address already has an account. No email; the role is granted now. | `ACTIVE` |

Details: [vendor-admin-api.md §3](vendor-admin-api.md#3-invite-a-vendor-user).

### Step 3 — Vendor user sets their password

They open the Clerk email, choose a password, and land on
`ADMIN_INVITATION_REDIRECT_URL`. Behind the scenes (§3) their account is
created, the `VENDOR` role is granted and their membership turns `ACTIVE`.
From then on they sign in like anyone else.

### Step 4 — Admin assigns drops, with a per-variant allotment

The chip is embedded in the product, and products come in variants, so the
vendor is told how many of **each variant** to make:

```http
POST /api/v1/admin/supply/vendors/:vendorId/drops
{ "dropId": "<red tee>",
  "variants": [ { "variantId": "<Red/S>", "quantity": 100 },
                { "variantId": "<Red/M>", "quantity": 100 },
                { "variantId": "<Red/L>", "quantity": 100 } ] }
```

A drop without variants takes `{ "dropId": "…", "quantity": 500 }` (or no
quantity for no cap). Change it later with
`PUT …/drops/:dropId/allotment`. Assignments can be made before or after the
user joins. Details:
[vendor-admin-api.md §5](vendor-admin-api.md#5-drop-assignments-and-variant-allotments).

### Step 5 — Vendor signs in and sees their drops

```http
GET /api/v1/vendor/me        → vendor + membership
GET /api/v1/vendor/drops     → only assigned drops, with allotted / booked / remaining per variant
```

### Step 6 — Vendor books a consignment

```http
POST /api/v1/vendor/batches
{ "dropId": "<red tee>", "itemType": "APPAREL", "batchRef": "SZ-2026-114",
  "lines": [ { "variantId": "<Red/S>", "quantity": 100 },
             { "variantId": "<Red/M>", "quantity": 100 },
             { "variantId": "<Red/L>", "quantity": 100 } ] }
```

The drop must be assigned (`403 SUPPLY_DROP_NOT_ASSIGNED`), and for a drop
with variants the vendor must say how many of **each** variant the shipment
holds. A shipment can carry any subset of variants — e.g. S and M now, L next
week. The consignment's `quantity` is the sum of its lines; it starts
`UPLOADED`.

Booking **more** than the allotment is allowed (the factory over-produced
Red/S by 20, say). The response's `allotment.covered: false` flags it.

### The consignment lifecycle

```
 vendor books          HitBox validates        vendor uploads chips        HitBox accepts
 ───────────▶ UPLOADED ───────────────▶ VALIDATED ─────────────────▶ (all units chipped) ──▶ ACCEPTED
                  │                         │                                                │
                  └──── REJECTED ◀──────────┘                         units minted into the drop,
                                                                     each bound to its chip
```

### Step 7 — HitBox validates the consignment

```http
POST /api/v1/admin/supply/batches/:batchId/decision
{ "status": "VALIDATED" }
```

HitBox has checked the paperwork (quantities, variants, invoice) and tells
the vendor to send the chip UIDs.

### Step 8 — Vendor uploads the chip UIDs

```http
POST /api/v1/vendor/batches/:batchId/tags
{ "tags": [ { "uid": "04:A1:B2:C3:D4:E5:01", "variantId": "<Red/S>" }, … ], "dryRun": false }
```

- Only once the consignment is **VALIDATED** (`409 SUPPLY_BATCH_NOT_VALIDATED`
  before that). A `dryRun: true` check is allowed at any time.
- One row per physical product, matching the consignment numbers. Each row
  names the variant of the product it is embedded in, and no variant can take
  more chips than its line.
- Up to 1,000 rows per call. Larger shipments are sent in several calls.
- Example files: [examples/chip-manifest-red-tee.csv](examples/chip-manifest-red-tee.csv)
  (with variants), [examples/chip-manifest-figure-no-variants.csv](examples/chip-manifest-figure-no-variants.csv)
  (without). See [vendor-portal-api.md §6](vendor-portal-api.md#6-chip-manifest)
  for how a CSV row becomes a JSON row.

### Step 9 — HitBox accepts → units appear on the drop

```http
POST /api/v1/admin/supply/batches/:batchId/decision
{ "status": "ACCEPTED" }
```

Accept is allowed only when:

1. **every declared unit has a chip.** Per variant line, `rowsReceived` must
   equal `quantity`. Otherwise `409 SUPPLY_MANIFEST_INCOMPLETE`, with the
   shortfall per variant in `details.lines`.
2. **the vendor's allotment covers it.** See below.
3. **the drop has cleared release approval.** Otherwise
   `409 SKUS_NOT_APPROVED` (`details`: `approvalId`, `version`, `status`). This is
   the same rule as the admin mint endpoint: no units exist for a drop the
   artist or brand hasn't approved.
4. **the drop type's variant rules hold.** A variant must be active and not
   archived (`PRODUCTS_VARIANT_INACTIVE`), and a REQUIRED-variant drop can't take
   units without a variant (`PRODUCTS_VARIANTS_REQUIRED`).
5. **each variant's own cap has room.** Checked against `DropVariant.totalSupply`
   (`409 PRODUCTS_VARIANT_SUPPLY_EXCEEDED` in the pre-check, or
   `409 SKUS_VARIANT_SUPPLY_EXCEEDED` if it fills up during the transaction). The
   `details` carry `variantId`, the cap, how many are minted and how many were
   requested.
6. **the drop's `totalSupply` has room** for the new units. Otherwise
   `409 SKUS_SUPPLY_EXCEEDED`.

Any refusal leaves everything unchanged: no units, chips still unbound, and the
consignment still `VALIDATED`. Fix the cause (approve the release, raise the
variant or drop supply, raise the allotment) and accept again.

#### Safe under concurrency

| Race | What happens |
|---|---|
| Two admins click Accept on the same consignment | The consignment row is locked and its status re-checked inside the transaction. The second click gets `409 SUPPLY_BATCH_STATE_INVALID`, so units are never minted twice. |
| Two consignments of the same drop accepted at once | Accepts into one drop are serialised by a per-drop lock. The allotment and caps are re-checked on settled numbers, so two cartons can't both slip under the same allotment or cap. |
| An admin mints units of the same drop meanwhile | The serial-number collision rolls the accept back and it is retried automatically (up to 3 times, then `409 SUPPLY_ACCEPT_CONFLICT`). Drop and variant caps are re-enforced inside the mint. |
| A chip upload races the accept, or another upload | Each upload locks the consignment row and re-checks status, the batch quantity and each line's quantity before writing. A UID registered by a parallel upload returns `409 SUPPLY_TAG_UID_TAKEN`, not a server error. |

In a single transaction, the accept then:

- mints **one SKU unit per chip that did not fail QC** into the drop, with that
  chip's variant, the next serial numbers, `vendorId`, `supplyBatchId` and a
  MINT ledger record;
- binds each unit to its chip (`Sku.currentNfcTagId` ↔ `NfcTag.skuId`, both
  `BOUND`);
- sets the consignment to `ACCEPTED`.

The response carries
`stock: { minted, units: [{ variantId, count, firstSerial, lastSerial }] }`.
Drop availability is computed from live SKU rows, so the drop's unit counts and
"available" figures update immediately. A buyer tapping one of these chips
reaches its unit: claims looks the UID up by hash, so the UID is never stored
in the clear.

Chips that **failed QC** stay in the consignment as rejected rows and do not
become units.

**If the consignment exceeds the allotment**, the accept answers
`409 SUPPLY_ALLOTMENT_INSUFFICIENT`, naming each short variant and a ready-made
fix. To take the extra stock, raise the allotment, then accept:

```http
PATCH /api/v1/admin/supply/vendors/:vendorId/drops/:dropId/allotment
{ "variants": [ { "variantId": "<Red/S>", "quantity": 120 } ] }     ← only Red/S changes
```

Or reject the consignment — rejection is never blocked. See
[vendor-admin-api.md §5](vendor-admin-api.md#5-drop-assignments-and-variant-allotments).

---

## 3. How sign-up works (the password step)

Vendor sign-up **is** the existing staff invitation — the same flow used to
invite admins and artists
([authorization/admin-provisioning.md](../authorization/admin-provisioning.md)).
Nothing about passwords is stored or handled by this backend; Clerk owns it.

```
Admin console          supply module            access-control             Clerk
─────────────          ─────────────            ──────────────             ─────
POST members ───────▶  IVendorInvitations
                        .invite(email) ───────▶ StaffInvitation
                                                 role = VENDOR, scope OWN
                                                 sendInvitation ─────────▶ email
                        VendorMember INVITED
                        (invitationId linked)
                                                                            user sets
                                                                            password
                                                 ◀── user.created webhook ──┘
                                                 users.account.provisioned
                                                 claimFor(email) → VENDOR role
                                                 staff.invitation-accepted
                        ◀───────────────────────┘
                        VendorMember ACTIVE, userId set
```

Why two rows (`StaffInvitation` and `VendorMember`)? access-control knows
*roles*; it has no idea what a vendor is. The `VendorMember` row is the part
only supply knows: **which vendor** this account acts for. The portal reads
that row on every request.

---

## 4. Membership states

```
INVITED ──(accepts invitation)──▶ ACTIVE
   │                                 │
   └──────────(admin revokes)────────┴──▶ REVOKED   (final)
```

| State | Portal access | Notes |
|---|---|---|
| `INVITED` | ❌ | Waiting for sign-up. Invitation expires after `ADMIN_INVITATION_TTL_HOURS` (72h default). |
| `ACTIVE` | ✅ | |
| `REVOKED` | ❌ | Final. To let the person back in, invite them again (a new row). |

---

## 5. Edge cases

| Situation | What happens |
|---|---|
| Invitation expired before sign-up | Member stays `INVITED`; the account that eventually signs up gets no role. Revoke the member and invite again. |
| Address already belongs to a member of **another** vendor | `409 SUPPLY_VENDOR_MEMBER_OTHER_VENDOR`, checked **before** any email is sent. Revoke the other membership first. |
| Address already invited / active at **this** vendor | `409 SUPPLY_VENDOR_MEMBER_EXISTS`. |
| Vendor deactivated (`isActive: false`) or archived | Its users can still **read** in the portal, but cannot book consignments or upload manifests (`403 SUPPLY_VENDOR_INACTIVE`). No new invites or drop assignments. |
| Drop unassigned after a consignment was booked | The consignment stays (and stays visible to the vendor). Further manifests against it are refused. HitBox staff can still complete it from the admin side. |
| Member revoked | Portal closes on the next request. The VENDOR role assignment is left in place but reaches nothing without an ACTIVE membership; revoke it on the Team screen if you want it gone too. |
| Several people at one vendor | Invite each one; every member acts for the same vendor. |
| Consignment rejected by HitBox | Its units stop counting as booked — the allotment is free to re-supply. |
| Some chips failed QC | They count as received (so the manifest is complete) but are not minted. The drop gets fewer sellable units than the consignment declared. |
| Drop's `totalSupply` is full | Accept fails with `SKUS_SUPPLY_EXCEEDED` and nothing is written. Raise the drop's `totalSupply` (drop admin) and accept again. |
| A variant's cap is full | Accept fails with `PRODUCTS_VARIANT_SUPPLY_EXCEEDED` / `SKUS_VARIANT_SUPPLY_EXCEEDED`, naming the variant. Raise that variant's `totalSupply` or reject. |
| Drop not release-approved yet | Accept fails with `SKUS_NOT_APPROVED`. The consignment waits in `VALIDATED` with its chips; accept once the release is approved. |
| Consignment with no drop (platform stock) | Accepting records the chips as stock only. No units are minted. |
| Vendor books more than allotted | Allowed and flagged (`overBooked`, `allotment.covered: false`). HitBox must raise the allotment (`PATCH …/allotment`) before accepting. |
| Admin lowers an allotment | Allowed down to what HitBox has already **accepted**, never below (`409 SUPPLY_ALLOTMENT_BELOW_ACCEPTED`). |
| Variants added to a drop after assignment | The vendor can book them (shown at `allotted: 0`), but HitBox must add them to the allotment (`PATCH …/allotment`) before accepting. |
| Two vendors on one drop | Fine — e.g. one allotted S/M, the other L. Allotments are per vendor. |

---

## 6. Deployment checklist

1. `pnpm db:deploy` — applies `20261025100000_vendor_portal` and
   `20261025120000_vendor_variant_allotments`.
2. `pnpm db:seed:authz` — creates the `VENDOR` role and the two
   `vendor-supply:*:own` permissions. **Until this runs, inviting answers
   `503 SUPPLY_VENDOR_INVITATIONS_UNAVAILABLE`.**
3. `CLERK_SECRET_KEY` set (already required for staff invitations), and
   `ADMIN_INVITATION_REDIRECT_URL` pointing at a page the vendor portal
   frontend serves.
4. **`NFC_TAG_UID_KEY` set** (any secret ≥ 32 characters, e.g. the output of
   `openssl rand -hex 32`). Without it, chip upload answers
   `503 SUPPLY_TAG_KEY_UNAVAILABLE` for vendors and staff alike, and taps can't
   resolve minted units. Keep it **stable**: chips registered under one key
   cannot be matched after the key changes. Optionally set
   `NFC_TAG_KEY_REFERENCE` (default `env:v1`).
