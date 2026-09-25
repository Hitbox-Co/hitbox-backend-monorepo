# Drop Inventory Management — Editing SKU Records

> Changing serialized units after they exist: trust flags, tag lifecycle
> state, variant, listing and archival state — one unit at a time or a
> thousand in one transaction — plus the filter set that makes finding the
> right thousand possible.
>
> Creating units, binding NFC tags, and per-role unit **visibility** are in
> [sku-api.md](sku-api.md). Read section 6 of that document first if you have
> not: what comes back from these endpoints is shaped by the caller's grants,
> and this document does not repeat the matrix.
>
> The rest of the admin write surface: [admin-write-apis.md](admin-write-apis.md).
> Session handling: [authentication.md](authentication.md).

---

## 1. What this is for

A drop's inventory is its `Sku` rows — one per physical object. Minting
creates them; this is everything that happens to them afterwards, and it is
mostly four jobs:

| Job | What it touches |
|---|---|
| **Staging a release** | `isActive` — units exist but are not listed yet |
| **Fraud and disputes** | `flagged`, `resaleBlocked`, `tamperStatus` |
| **Tag custody** | `tagLifecycleState`, vendor and batch references |
| **Retiring stock** | `archived` — units that will never ship |

Three of those four routinely apply to *a range of an edition* rather than one
item — "the last 100 of this drop were destroyed in transit", "this vendor
consignment is compromised" — which is why the batch endpoint exists and why
its selectors are shaped the way they are.

### Endpoints added

| Method | Path | Capability |
|---|---|---|
| `PATCH` | `/api/v1/admin/skus/:skuId` | `collectible-instance:manage`, against the drop's org |
| `PATCH` | `/api/v1/admin/skus/batch` | `collectible-instance:manage` — **global grants only** |
| `PATCH` | `/api/v1/admin/products/:productId/skus/batch` | `collectible-instance:manage`, against the drop's org |

The nested batch route is not a convenience alias. A router with no product in
its path has no organization to check a grant against, so `/admin/skus/batch`
admits global grants only — exactly like `GET /admin/skus`. An
organization-scoped caller (a Brand Admin) reaches batch editing through the
nested form, and is confined to that drop by the same context check.

---

## 2. What is editable, and what is not

`PATCH` semantics throughout: **an absent key means "leave it alone"**, and
`null` is a value. `{"tamperStatus": null}` clears the note; omitting
`tamperStatus` does not touch it.

The body is **strict** — an unknown field is a `422`, not a silently ignored
key. A caller who believes they just transferred ownership should find that out
on the request, not a week later.

### Editable

| Field | Type | Requires | Notes |
|---|---|---|---|
| `variantId` | uuid \| null | `collectible-instance:manage` | must belong to this unit's product |
| `isActive` | boolean | " | listing availability |
| `archived` | boolean | " | `true` archives **and** delists; refused on a held unit |
| `resaleBlocked` | boolean | " | needs a reason, here or already on the row |
| `resaleBlockedReason` | string \| null | " | ≤500 chars |
| `tamperStatus` | string \| null | " | free text, e.g. `SEAL_BROKEN` |
| `flagged` | boolean | " | the investigation freeze — see 2.2 |
| `tagLifecycleState` | enum | **`nfc-tag-claim:manage`** | `LOST` / `REVOKED` / `DISPUTED` / back to `BOUND` |
| `vendorId` | uuid \| null | " | |
| `provisioningBatchId` | string \| null | " | free-text consignment reference |
| `vendorAuthenticated` | boolean | " | stamps or clears `vendorAuthenticatedAt` |
| `reason` | string | — | audit trail only; **not** a column |

The split at `tagLifecycleState` is the same separation the mint and tag
endpoints already draw: a Drop Manager holds `collectible-instance:manage` and
no `nfc-tag-claim` grant at all, so they can archive half an edition and cannot
revoke one tag. A body mixing both is refused **in full** with a `403` naming
the fields — nothing partial is written.

### Not editable, deliberately

| Column | Why not |
|---|---|
| `skuCode`, `serialNumber`, `productId` | The unit's identity. `#014 of 500` is printed on an object in somebody's hands; changing the row does not change the object |
| `ownerId` | Ownership moves through the claims module, which writes the provenance chain as it goes. An admin write here would move an item with no provenance behind it |
| `claimToken`, `claimTokenIssuedAt`, `claimTokenUsedAt` | Never read, never written, never returned. A live one-shot token in a response body is a claim somebody else can make |
| `lastTapCounter` | A monotonic anti-replay counter. Its entire value is that nothing can lower it |
| `claimedStatus` | Editable only through `flagged`, below |
| `tagId` | Bound through `PATCH /admin/skus/:skuId/tag`, which has its own re-tagging rules — see [sku-api.md 3a](sku-api.md) |
| `createdAt`, `updatedAt` | `updatedAt` moves on every write here |

### 2.1 `reason` is required for four changes

Freezing a unit, archiving one, and marking a tag `LOST` or `REVOKED` all
require a non-empty `reason`. Each stops something — the unit stops being
sellable, stops being listed, or its tag stops being trusted — and six months
later the only question anybody asks about that row is *why*. A trail that
cannot answer it is a log, not an audit.

`resaleBlocked` is exempt because `resaleBlockedReason` already is the reason,
and asking for both is the same sentence typed twice.

### 2.2 `flagged` — the only way `claimedStatus` moves here

```jsonc
{ "flagged": true,  "reason": "counterfeit report #88" }   // → FLAGGED
{ "flagged": false }                                        // → CLAIMED or UNCLAIMED
```

Unflagging does **not** restore "whatever it was before". That value is not
recorded anywhere, and inventing it would be a fabrication. It derives the
state from the column that is actually authoritative: a unit with an `ownerId`
is `CLAIMED`, one without is `UNCLAIMED`.

`IN_TRANSFER` is refused in both directions. A transfer in flight is a
half-written ownership change owned by the claims module; freezing it from
outside would strand it, and there is no state to return it to.

### 2.3 Tag lifecycle transitions

```
UNPROVISIONED ──(bind a tag)──▶ BOUND ──(first claim)──▶ ACTIVE
                                  │                        │
                                  └──────┬─────────────────┘
                                         ▼
                            LOST ◀──▶ DISPUTED ──▶ REVOKED  (terminal)
                              │           │
                              └───────────┴──▶ BOUND   (it turned up)
```

| Rule | Why |
|---|---|
| `ACTIVE` is never settable by hand | It is reached on first claim, by the claims module. Writing it here would make the column describe an intention rather than the tag |
| `UNPROVISIONED` is never settable | It means no tag was ever written to this unit — a fact about the past |
| `REVOKED` is terminal | If it could be walked back, "revoked" would mean "revoked for now". The state exists precisely because it cannot |
| A unit with no `tagId` is refused | Its lifecycle state describes nothing. Bind a tag first |

This is what unblocks the re-tagging path in [sku-api.md 3a](sku-api.md) rule
5: a claimed unit whose tag is still healthy cannot be re-tagged, and this is
the endpoint that marks the old tag `LOST` first.

---

## 3. `PATCH /api/v1/admin/skus/:skuId`

```http
PATCH /api/v1/admin/skus/aa11bb22-cc33-dd44-ee55-ff6677889900
Authorization: Bearer <clerk session token>
Content-Type: application/json
```

```json
{
  "resaleBlocked": true,
  "resaleBlockedReason": "Chargeback on order 3344 — pending investigation",
  "tamperStatus": "SEAL_BROKEN"
}
```

Returns the full unit detail, shaped for your grants — the identical body
`GET /admin/skus/:skuId` would give you.

```json
{
  "data": {
    "skuId": "aa11bb22-cc33-dd44-ee55-ff6677889900",
    "skuCode": "123456780042-000014",
    "serialNumber": 14,
    "claimedStatus": "CLAIMED",
    "isActive": true,
    "archivedAt": null,
    "createdAt": "2026-09-15T10:04:22.118Z",
    "updatedAt": "2026-09-22T11:20:03.774Z",
    "trust": {
      "resaleBlocked": true,
      "resaleBlockedReason": "Chargeback on order 3344 — pending investigation",
      "tamperStatus": "SEAL_BROKEN"
    },
    "tag": {
      "tagId": "04A39B2C5D6E80",
      "tagLifecycleState": "ACTIVE",
      "lastTapCounter": 7,
      "vendorId": null,
      "provisioningBatchId": "BATCH-2026-09-41",
      "vendorAuthenticatedAt": null
    },
    "product": { "productId": "0f1e2d3c-…", "groupCode": "123456780042", "…": "…" }
  }
}
```

### A body that changes nothing is a success, not an error

Re-sending an edit that already landed — a retried request, a form submitted
twice — returns the unit unchanged with `200`. Nothing is written, no audit
row, no event. The endpoint is safe to retry, which matters because the batch
form is a transaction that a client may well have to resend.

---

## 4. `PATCH /api/v1/admin/skus/batch`

One set of changes, applied to every selected unit, in one transaction.

```json
{
  "productId": "0f1e2d3c-4b5a-6978-8766-554433221100",
  "targets": { "serialFrom": 401, "serialTo": 500 },
  "changes": {
    "archived": true,
    "reason": "Pallet destroyed in transit — insurer claim INS-2026-114"
  },
  "dryRun": false
}
```

On the nested route the `productId` comes from the path and the body field is
unnecessary.

### 4.1 Selectors — exactly one

| Selector | Shape | Needs a `productId` | For |
|---|---|---|---|
| `skuIds` | uuid[] | no | a selection made in a table |
| `skuCodes` | string[] | no | a scanned or pasted list |
| `serialNumbers` | int[] | **yes** | positions read off cards |
| `serialFrom` + `serialTo` | int, int | **yes** | a contiguous block of an edition |

Serials are positions within one drop's edition, not platform-wide
identifiers, so the three serial-based selectors need a drop to count within.

Up to **1000 units per call**, and a serial range may span at most 1000. A
5,000-unit edition is five calls. The cap is the same as a tag manifest and for
the same reason: the whole batch is one transaction, and one updating 10,000
rows holds locks long enough to matter.

### 4.2 All or nothing

**If one selected unit refuses the change, nothing is written** and the
response names every refusal at once:

```json
{ "error": {
    "code": "SKUS_BATCH_REJECTED",
    "message": "Batch rejected, nothing was written. 123456780042-000412: is CLAIMED — a unit somebody is holding cannot be archived. Archiving hides a real object from the platform while its owner still has it in their hands.; 123456780042-000417: is CLAIMED — …",
    "details": null } }
```

Partial application is the state to avoid, not the error. An operator told
"312 of your 400 units took the change" has a reconciliation problem the
database cannot help with — which unit took it is a question only the warehouse
can answer. Same reasoning as the tag manifest in
[sku-api.md 3a](sku-api.md) rule 2.

Beyond 20 refusals the message is truncated with `(and N more)`; the full list
is in the audit row.

### 4.3 Units already in the requested state are **not** refusals

Selecting 200 rows of which 13 are already blocked is ordinary — it is what
acting on a filtered list looks like. Those 13 are counted as `unchanged` and
skipped; the other 187 are written.

### 4.4 `dryRun`

Resolves and validates everything, writes nothing, records nothing. This is
what a console shows in a confirmation dialog before somebody commits to
archiving a hundred units.

### 4.5 Response

```json
{
  "data": {
    "productId": "0f1e2d3c-4b5a-6978-8766-554433221100",
    "requested": 100,
    "matched": 97,
    "changed": 84,
    "unchanged": 13,
    "dryRun": false,
    "items": [
      { "skuId": "…", "skuCode": "123456780042-000401", "serialNumber": 401, "changed": ["archivedAt", "isActive"] },
      { "skuId": "…", "skuCode": "123456780042-000402", "serialNumber": 402, "changed": [] }
    ]
  }
}
```

| Field | Means |
|---|---|
| `requested` | how many units the selector named |
| `matched` | how many of those exist and you can reach |
| `changed` | how many actually differed and were written |
| `unchanged` | matched, but already in the requested state |
| `items[].changed` | the columns that moved — empty for a no-op |

`requested > matched` is only tolerated for a **serial range**: `#401–500`
over an edition that reached 460 is a perfectly ordinary way to say "the tail
of this drop". An explicitly listed id, code or serial that is not there is an
operator mistake and refuses the batch.

---

## 5. Filters

Every filter below works on all three list endpoints:

- `GET /api/v1/admin/products/:productId/skus`
- `GET /api/v1/admin/skus`

### 5.1 The full set

| Param | Type | Notes |
|---|---|---|
| `page` / `limit` | int | `1` / `50`, max `200` |
| **Which drop** | | |
| `productId` | uuid | cross-drop list only; the nested route has it in the path |
| `organizationId` | uuid | narrows within your reach — it does not widen it |
| `variantId` | uuid | |
| `hasVariant` | boolean | `false` = units belonging to no variant |
| **Which units** | | |
| `claimedStatus` | enum, **repeatable** | `?claimedStatus=UNCLAIMED,FLAGGED` |
| `tagLifecycleState` | enum, **repeatable** | |
| `serialFrom` / `serialTo` | int | inclusive |
| `skuCode` | string, repeatable | exact codes |
| **Tag custody** 🔒 | | requires `nfc-tag-claim` |
| `tagged` | boolean | *ungated* — `false` = awaiting a tag |
| `tagId` | string | any separator style; normalised |
| `vendorId` | uuid | |
| `provisioningBatchId` | string | |
| **Trust** 🔒 | | requires `collectible-instance` at FULL |
| `resaleBlocked` | boolean | |
| `tampered` | boolean | `true` = carries any tamper note |
| `tamperStatus` | string | exact |
| **Ownership** 🔒 | | requires `buyer-profile` at FULL |
| `ownerId` | uuid | |
| `hasOwner` | boolean | *ungated* — `claimedStatus=CLAIMED` says the same |
| **Lifecycle** | | |
| `isActive` | boolean | |
| `includeArchived` | boolean | default `false` |
| `archivedOnly` | boolean | archived units and nothing else |
| `createdFrom` / `createdTo` | ISO date | |
| `updatedFrom` / `updatedTo` | ISO date | |
| **Other** | | |
| `search` | string | serial number, `skuCode` fragment, or full tag UID |
| `sort` | enum | `serial_asc` (default), `serial_desc`, `newest`, `oldest`, `recently_updated`, `code_asc` |

Repeatable parameters accept `?k=a,b` or `?k=a&k=b`. A digits-only `search`
term matches the serial number as well as the code, because an operator
holding the item reads "#14" off the card.

### 5.2 🔒 A filter is a read of the column it names

This is the part worth internalising, because it is easy to get wrong in the
other direction.

The response projection carefully omits a tag UID from a caller without
`nfc-tag-claim`. Left ungated, `?tagId=04A39B2C5D6E80` hands them the same
fact anyway: **one row back means yes, zero means no**, and enough of those
questions is the whole secret. The filter never returns the value; it lets the
caller ask yes/no questions until they have it.

So every filter naming a gated column is gated by the same grant that gates
the column in the response, and a refused filter is a `403` naming all of them
at once:

```json
{ "error": {
    "code": "SKUS_FILTER_FORBIDDEN",
    "message": "You may not filter by tagId, ownerId: filtering a column is a read of it, and these are not shown to you.",
    "details": null } }
```

The `search` box follows the same rule: its tag-UID branch is only included
for a caller who may read UIDs, or `?search=04A3…` would be `?tagId=04A3…`
spelled differently.

**Not gated, on purpose:** `tagged` and `tagLifecycleState` are population
facts, not identifying ones — "how many units still need a tag" is the
documented way a Drop Manager drives a partial rollout, and no amount of asking
it yields a UID. `hasOwner` is ungated because `claimedStatus=CLAIMED` already
answers it.

### 5.3 Two fixes this changed

**`?flag=false` used to mean `true`.** Boolean query params were parsed with
`z.coerce.boolean()`, which is `Boolean(input)` — and `Boolean('false')` is
`true`. So `?tagged=false` returned the *tagged* units and
`?includeArchived=false` included the archived ones. Booleans now accept
`true` / `false` / `1` / `0` and mean what they say. **If a client was
compensating for this, it will now be wrong in the other direction.**

**`?search=<tag UID>` matched tags for everybody**, including callers who are
shown no tag block at all. It is now gated as described above.

---

## 6. Who can do what

Reaching these endpoints is `collectible-instance:manage`; the tag fields need
`nfc-tag-claim:manage` on top. Both are resolved from the caller's own grants,
never from the request.

| Role | Edit units | Edit tag custody | Batch scope |
|---|---|---|---|
| `HITBOX_SYSTEM_ADMIN` | ✅ | ✅ | all drops |
| `HITBOX_DROP_MANAGER` | ✅ | ❌ `403` | all drops |
| `BRAND_ADMIN` | ✅ own org | ❌ `403` | own drops, nested route only |
| `BRAND_EMPLOYEE` | ✅ own org | ❌ `403` | own drops, nested route only |
| `HITBOX_SUPPORT` | ❌ `403` | ❌ | — |
| `ARTIST` | ❌ `403` | ❌ | — |
| everyone else | ❌ `403` | ❌ | — |

Support holds `collectible-instance:read:masked` — read, and masked. They
investigate; they do not edit. `HITBOX_CONTENT_MANAGER` holds
`collectible-instance:update:global`, which `update` neither implies nor is
implied by `manage`, so it is refused here too — the same catalog oddity
already noted in [sku-api.md 6](sku-api.md).

---

## 7. The audit trail

Every write records one row, **awaited before the caller is told it worked**.
An edit that happened with nothing to show for it is worse than one that failed
loudly.

| Event | Severity | Carries |
|---|---|---|
| `sku.update` | `CRITICAL` | before/after for the changed columns only, plus `reason` |
| `sku.batch-update` | `CRITICAL` | the change, the counts, and the list of unit ids |

Refusals are recorded too, as `result: "DENIED"` — an attempted freeze that the
rules refused is exactly the sort of thing a review goes looking for. Field-level
`403`s are not, because nothing was loaded and the authorization layer already
logs them.

Both are `CRITICAL` rather than `WARNING` because of what is reachable through
them: a tag marked `REVOKED` stops an owner verifying an object they are
holding.

Batch rows carry field names and unit ids, not a thousand before/after pairs —
that volume buries the one fact a review needs, which is what changed and on
which units.

### Deployment note

`AuditEvent.eventType` is a foreign key to `AuditEventType`, so these two keys
must exist in that table before an edit can be written — otherwise the audit
row fails, and the recorder fails the edit with it. Run the seed:

```bash
pnpm db:seed:audit
```

Idempotent, and needed on every deploy alongside `pnpm db:seed:authz`. This was
added with these endpoints: the seed had no script entry and the table held 3 of
41 event types, which would have made every audited write in the platform a
`500`. See [audit-logging.md](../audit/audit-logging.md).

---

## 8. Errors

| HTTP | `code` | Raised when |
|---|---|---|
| `400` | `SKUS_NO_CHANGES` | the body names no editable field |
| `400` | `SKUS_UPDATE_REFUSED` | a required `reason` is missing |
| `400` | `SKUS_VARIANT_MISMATCH` | `variantId` belongs to a different product, or a batch setting one spans several drops |
| `400` | `SKUS_PRODUCT_NOT_FOUND` | a serial selector with no `productId` |
| `403` | `SKUS_UPDATE_FORBIDDEN` | the body names fields your grants do not cover |
| `403` | `SKUS_FILTER_FORBIDDEN` | the query filters a column you are not shown |
| `403` | `AUTHZ_FORBIDDEN` | the route's capability check failed outright |
| `404` | `SKUS_NOT_FOUND` | no such unit, **or** it belongs to a drop outside your organization |
| `404` | `SKUS_BATCH_EMPTY` | the selection matched no units at all |
| `409` | `SKUS_UPDATE_REFUSED` | the unit's own state refuses the change |
| `409` | `SKUS_BATCH_REJECTED` | at least one unit refused; nothing was written |
| `422` | `VALIDATION_ERROR` | schema failure — an unknown field, two selectors, a range over 1000 |

Out-of-scope records return `404`, not `403`: a `403` confirms the id exists,
which is itself a fact about another brand's catalog.

---

## 9. Recipes

**Stage an edition, then release it.**
```jsonc
// mint inactive (see sku-api.md 3), then on release day:
PATCH /admin/products/:id/skus/batch
{ "targets": { "serialFrom": 1, "serialTo": 500 }, "changes": { "isActive": true } }
```

**A consignment of tags is compromised.**
```jsonc
// 1. find them
GET /admin/skus?provisioningBatchId=BATCH-2026-09-41&limit=200
// 2. revoke, after checking the blast radius
PATCH /admin/skus/batch
{ "targets": { "skuIds": ["…"] },
  "changes": { "tagLifecycleState": "REVOKED", "reason": "Vendor breach VB-2026-03" },
  "dryRun": true }
```

**Re-tag a claimed unit whose chip failed.** The re-tag is refused while the
tag is healthy, so mark it lost first:
```jsonc
PATCH /admin/skus/:skuId       { "tagLifecycleState": "LOST", "reason": "chip failed on read" }
PATCH /admin/skus/:skuId/tag   { "tagId": "04A39B2C5D6E99", "replace": true }
```

**Freeze a unit pending a counterfeit investigation, then release it.**
```jsonc
PATCH /admin/skus/:skuId { "flagged": true, "resaleBlocked": true,
                           "resaleBlockedReason": "counterfeit report #88",
                           "reason": "counterfeit report #88" }
// cleared:
PATCH /admin/skus/:skuId { "flagged": false, "resaleBlocked": false }
```

**Retire the tail of an edition.** Archiving refuses held units, so check
first with a dry run and narrow the range if it reports refusals.

---

## 10. The approach, and why

**Two endpoints, not one per field.** A `POST /skus/:id/block-resale`,
`/archive`, `/flag` surface would be seven routes, seven capability checks and
seven places that each decide half of "may this unit change". The rules
interact — archiving delists, unflagging depends on ownership, blocking needs a
reason — so they belong in one planner that sees the whole intended state.

**The rules are a pure function.** `packages/skus/src/domain/sku-update.ts`
takes a unit, a set of changes and a clock, and returns a patch or a reason it
cannot. No Prisma, no request. That is what makes "one unit" and "eight hundred
units" the same rules rather than two implementations that drift — and the
eight-hundred case is the one where half-correct rules are discovered by a
warehouse rather than by a test.

**No new capability was invented.** These endpoints reuse
`collectible-instance:manage` and `nfc-tag-claim:manage`. A `sku:edit`
capability would have meant a new `ResourceType` value, a migration, a catalog
change for every role, and a second place deciding who may touch the platform's
most sensitive table.

**Batch is uniform, not per-unit.** The screen this serves is "filter a list,
select rows, act on the selection". A per-unit payload already exists — it is
the tag manifest — and a second one under a worse name would be the wrong
shape for the actual job.

**The filter gate came out of building the filters.** Adding `?tagId=` made it
obvious that the existing `?search=` already leaked the same fact, and that the
response projection's care was being undone by the query string. The gate and
the projection now live next to each other so they cannot drift.

---

## 11. Not built

| Gap | Note |
|---|---|
| Transfer ownership administratively | `ownerId` stays read-only; ownership moves through the claims module so the provenance chain is written with it |
| Undo a batch | Each batch records the units it touched, so an inverse batch can be composed from the audit row — but nothing does it for you |
| A filter-as-selector batch | `targets` names units explicitly. Sending a *filter* as the selector would mean the set changes between preview and commit |
| Link `provisioningBatchId` to `SupplyBatch` | Still a free-text reference; the `supply` module owns the table and nothing joins the two |
| Scheduled activation | `isActive` flips now. A release calendar lives in the releases module |
| Bulk tag rebinding | Batch edits lifecycle state, not `tagId`. Rebinding stays on the manifest endpoint, which has the clone-prevention rules |
