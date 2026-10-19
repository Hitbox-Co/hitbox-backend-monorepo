# Drop Types & Variants

> **What this is:** every drop now has a **type** (T-Shirt, Card, Poster…).
> The type decides which **variants** the drop can have — size × color for a
> T-shirt, format × pack size for cards, none at all for a keychain — and the
> API refuses anything that breaks those rules.
>
> Related: creating the drop itself — [product-upload-api.md](product-upload-api.md);
> minting serialized units — [sku-api.md](sku-api.md);
> who approves a drop before units can be minted — [drop-approval-lifecycle.md](drop-approval-lifecycle.md).

---

## Contents

1. [Quick start — the whole flow in 6 calls](#1-quick-start--the-whole-flow-in-6-calls)
2. [Words used in this document](#2-words-used-in-this-document)
3. [How it fits together](#3-how-it-fits-together)
4. [The built-in drop types](#4-the-built-in-drop-types)
5. [Drop types API](#5-drop-types-api)
6. [Drop create / update — what changed](#6-drop-create--update--what-changed)
7. [Variants API](#7-variants-api)
8. [Minting and submitting — what changed](#8-minting-and-submitting--what-changed)
9. [The validation rules](#9-the-validation-rules)
10. [What can change, and when](#10-what-can-change-and-when)
11. [Errors](#11-errors)
12. [Backward compatibility](#12-backward-compatibility)
13. [Data model](#13-data-model)
14. [Where the code lives](#14-where-the-code-lives)
15. [Setup on a new environment](#15-setup-on-a-new-environment)
16. [Frontend checklist](#16-frontend-checklist)
17. [Not built](#17-not-built)

---

## 1. Quick start — the whole flow in 6 calls

A T-shirt in 3 sizes × 2 colors, end to end. All paths are under
`/api/v1/admin`.

```http
# 1. Pick a type — the form shows its dimensions and values
GET /drop-types

# 2. Create the drop as a T_SHIRT
POST /products
{ "dropType": "T_SHIRT", "name": "Lumen Tour Tee", "totalSupply": 600,
  "prices": [{ "marketCode": "IN", "amount": "1999.00" }] }

# 3. Preview the variants, then create them
POST /products/:id/variants/generate
{ "select": { "size": ["S","M","L"], "color": ["BLK","WHT"] },
  "totalSupplyEach": 100, "dryRun": true }          ← 200, nothing written
# …same body with "dryRun": false                  ← 201, 6 variants created

# 4. Submit for the owner's approval (unchanged)
POST /releases            { "productId": ":id", … }

# 5. AFTER approval — mint units per variant (unchanged endpoint)
POST /products/:id/skus   { "count": 100, "variantId": ":variantId" }

# 6. Publish (unchanged)
POST /products/:id/publish
```

> ⚠️ **SKU units are still minted only after approval.** Nothing about the
> approval gate changed. A drop that names an artist or an organization
> cannot have units minted until its owner approves it
> (`409 SKUS_NOT_APPROVED`). A drop with neither owner is approved
> automatically at submit and is mintable straight away. Full rule:
> [drop-approval-lifecycle.md §10](drop-approval-lifecycle.md#10-minting-waits-for-approval).
> Variants are created **before** submitting, because the owner approves the
> drop *together with* its variants.

---

## 2. Words used in this document

"SKU" means two different things in conversation. In this codebase:

| You might say | Record | Example code | How many |
|---|---|---|---|
| Product / drop | `Drop` | `groupCode` `123456780000` | 1 per drop |
| **Variant** ("business SKU", sellable option) | `DropVariant` | `variantCode` `123456780000-M-BLK` | 1 per option combination |
| **Unit** (physical serialized item) | `Sku` | `skuCode` `123456780000-000014` | 1 per object, `#1…#supply` |

| Term | Meaning | Example |
|---|---|---|
| **Drop type** | The kind of product; holds the variant rules | `T_SHIRT` |
| **Dimension** | One axis a variant varies along | `size`, `color` |
| **Value** | One allowed choice on a dimension | `M`, `BLK` (Black, `#1A1A1A`) |
| **Variant mode** | Whether the type has variants: `NONE` / `OPTIONAL` / `REQUIRED` | keychain = `NONE` |
| **Rule** | A constraint between dimensions | "pack size only for packs" |

`skuCode` did **not** change — it is still `groupCode-serial`. A unit's code
is printed on a physical object and never depends on variant naming.

---

## 3. How it fits together

```
 Drop Type ─────▶ Variant rules ─────▶ Variants ─────────▶ (approval) ─────▶ Units
 T_SHIRT          size: S M L XL        S-BLK, S-WHT,        owner signs        Sku #1…#100
 variantMode      color: BLK WHT        M-BLK, …             off the drop       per variant
 = REQUIRED       (+ hex swatches)      DropVariant rows     with its variants  @hitbox/skus
```

**Order of operations for an admin:**

```
1. Choose type        GET  /drop-types
2. Create drop        POST /products              { dropType }
3. Add variants       POST /products/:id/variants/generate   (or /variants)
4. Price variants     PUT  /products/:id/prices   (optional per-variant prices — unchanged)
5. Submit             POST /releases              ← REQUIRED types need ≥ 1 variant here
6. Owner approves     POST /releases/:id/decision
7. Mint units         POST /products/:id/skus     { variantId }   ← only after step 6
8. Publish            POST /products/:id/publish
```

A `NONE` type (keychain) skips step 3 and mints with no `variantId` — exactly
how every drop worked before.

---

## 4. The built-in drop types

Seeded by `pnpm db:seed:drop-types`. A System Admin can add values (for
example new colors), dimensions, rules or whole new types through
[the API](#5-drop-types-api) — no code change.

| Code | Name | Mode | Dimensions (✱ = required) | Rules | Example variants |
|---|---|---|---|---|---|
| `T_SHIRT` | T-Shirt | `REQUIRED` | size✱ `XS S M L XL XXL` · color✱ 🎨 | — | `M-BLK`, `L-WHT` |
| `CAP` | Cap | `REQUIRED` | color✱ 🎨 · style `SNAPBACK FITTED TRUCKER DAD` | — | `BLK`, `NVY-FITTED` |
| `KEYCHAIN` | Key Chain | `NONE` | — | — | *(none — one sellable item)* |
| `ACTION_FIGURE` | Action Figure | `OPTIONAL` | edition✱ `STANDARD LIMITED` · variant `STANDARD SIGNED EXCLUSIVE` | — | `LIMITED`, `LIMITED-SIGNED` |
| `CARD` | Card | `REQUIRED` | format✱ `SINGLE PACK SET` · packSize `1 5 10` | packSize required for `PACK`, forbidden for `SINGLE`/`SET` | `SINGLE`, `PACK-5`, `PACK-10`, `SET` |
| `POSTER` | Poster | `REQUIRED` | size✱ `A4 A3 A2` · edition✱ `STANDARD LIMITED` | — | `A3-LIMITED` |
| `GENERIC` | Other | `OPTIONAL` | option✱ *(free-form)* | — | anything |

🎨 = a `COLOR` dimension: its values carry a hex code so screens can show a
swatch, and admins may enter custom colors for one drop. Seeded colors:

| Code | Label | Hex |
|---|---|---|
| `BLK` | Black | `#1A1A1A` |
| `WHT` | White | `#FFFFFF` |
| `NVY` | Navy | `#1F2A44` |
| `GRY` | Heather Grey | `#9EA3A8` |
| `RED` | Red | `#C8102E` |

---

## 5. Drop types API

Base path `/api/v1/admin/drop-types`.

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/` | `drop:read` | Active types (add `?includeInactive=true` for all, with archived dimensions/values) |
| `GET` | `/:code` | `drop:read` | One type, archived parts included, plus `dropCount` |
| `POST` | `/` | 🔒 `drop-type:manage` | Create a type, with its dimensions and values |
| `PATCH` | `/:code` | 🔒 | Name, description, rules, pattern, `isActive`, `variantMode` (only while unused) |
| `POST` | `/:code/dimensions` | 🔒 | Add a dimension |
| `PATCH` | `/:code/dimensions/:dimension` | 🔒 | Label, required, allowCustomValues, displayType, position |
| `DELETE` | `/:code/dimensions/:dimension` | 🔒 | Archive a dimension |
| `POST` | `/:code/dimensions/:dimension/restore` | 🔒 | Un-archive it |
| `POST` | `/:code/dimensions/:dimension/values` | 🔒 | Add a value (with `hexCode` on a COLOR dimension) |
| `PATCH` | `/:code/dimensions/:dimension/values/:value` | 🔒 | Label, hexCode, position |
| `DELETE` | `/:code/dimensions/:dimension/values/:value` | 🔒 | Archive a value |
| `POST` | `/:code/dimensions/:dimension/values/:value/restore` | 🔒 | Un-archive it |

🔒 = `drop-type:manage:global`, held **only by `HITBOX_SYSTEM_ADMIN`**.
Reading needs `drop:read`, like any drop screen.

Every write returns the **whole updated type**, so a screen can re-render from
the response without a second call.

### The type object

`GET /drop-types/T_SHIRT`

```json
{
  "data": {
    "id": "…",
    "publicCode": "dty0h2k9m4p7x3f8q2n",
    "code": "T_SHIRT",
    "name": "T-Shirt",
    "description": "Apparel sold by size and color — every unit is one size in one color.",
    "variantMode": "REQUIRED",
    "variantCodePattern": "{groupCode}-{values}",
    "version": 1,
    "isActive": true,
    "rules": [],
    "dimensions": [
      { "code": "size", "label": "Size", "position": 0, "required": true,
        "allowCustomValues": false, "displayType": "TEXT", "archived": false,
        "values": [ { "code": "S", "label": "S", "hexCode": null, "position": 1, "archived": false } ] },
      { "code": "color", "label": "Color", "position": 1, "required": true,
        "allowCustomValues": true, "displayType": "COLOR", "archived": false,
        "values": [ { "code": "BLK", "label": "Black", "hexCode": "#1A1A1A", "position": 0, "archived": false } ] }
    ],
    "dropCount": 4,
    "createdAt": "…", "updatedAt": "…"
  }
}
```

| Field | Notes |
|---|---|
| `variantMode` | `NONE` no variants · `OPTIONAL` may have them · `REQUIRED` must have ≥ 1 active variant to submit, and every unit must belong to one |
| `variantCodePattern` | How `variantCode` is built. Tokens `{groupCode}` and `{values}` (value codes joined by `-`); both are mandatory |
| `version` | Goes up whenever the rules change. Drops record the version their variants were checked against (`Drop.dropTypeVersion`) |
| `displayType` | `TEXT`, or `COLOR` — show swatches, values may have `hexCode` |
| `allowCustomValues` | The admin may type a value not in the list, for one drop (see §7) |
| `archived` | Hidden from new variants; existing variants keep it |

### Creating a type

`POST /drop-types`

```json
{
  "code": "hoodie",
  "name": "Hoodie",
  "variantMode": "REQUIRED",
  "dimensions": [
    { "code": "size", "label": "Size", "required": true,
      "values": [ { "code": "S", "label": "S" }, { "code": "M", "label": "M" } ] },
    { "code": "color", "label": "Color", "required": true, "displayType": "COLOR",
      "allowCustomValues": true,
      "values": [ { "code": "blk", "label": "Black", "hexCode": "1a1a1a" } ] }
  ],
  "rules": []
}
```

Normalised on the way in — the stored type is `HOODIE`, value `BLK`, hex `#1A1A1A`.

| Field | Format |
|---|---|
| `code` | `A–Z 0–9 _`, starts with a letter, 2–40 chars. Upper-cased for you. Never changes |
| dimension `code` | camelCase: `size`, `packSize` (starts lower-case, letters/digits) |
| value `code` | 1–12 letters/digits, no `-` (it's the separator in `variantCode`). Upper-cased for you. Numbers like `5` are fine |
| `hexCode` | `#RGB`, `RGB`, `#RRGGBB` or `RRGGBB` → stored as `#RRGGBB`. **Only on a `COLOR` dimension**; optional even there (no hex = no swatch) |
| `dimensions` | max 10; a `NONE` type takes none |
| values | max 100 per dimension |

### Rules

Rules are what make cards work, where *Pack Size* means nothing for a single
card. Three kinds:

```jsonc
// When format is PACK, packSize must be chosen
{ "kind": "require", "when": { "format": "PACK" }, "dimensions": ["packSize"] }

// When format is SINGLE or SET, packSize must NOT be chosen
{ "kind": "forbid", "when": { "format": ["SINGLE", "SET"] }, "dimensions": ["packSize"] }

// This exact combination is never allowed
{ "kind": "exclude", "match": { "edition": "STANDARD", "variant": "EXCLUSIVE" } }
```

- A `when`/`match` value is one value code or a list (any of them).
- `require`/`forbid` override a dimension's own `required` flag for the
  combinations they match.
- Rules may only name dimensions the type has (`400 PRODUCTS_DROP_TYPE_INVALID`).
- A dimension a rule still names cannot be archived — edit the rules first.
- Up to 50 rules per type. Set them with `PATCH /drop-types/:code { "rules": [...] }`
  (the list is replaced).

---

## 6. Drop create / update — what changed

**One new optional field, `dropType`** — a type code, case-insensitive.

```json
POST /api/v1/admin/products
{ "dropType": "CARD", "name": "Founders Series", "totalSupply": 1000, "prices": [ … ] }
```

| Situation | Result |
|---|---|
| `dropType` omitted or `null` | A **legacy** drop, exactly as before. No variant rules apply. |
| Unknown or inactive code | `404 PRODUCTS_DROP_TYPE_NOT_FOUND` |
| `REQUIRED` type **and** a `skus` block | `400 PRODUCTS_VARIANTS_REQUIRED` — a new drop has no variants yet, so inline units would belong to none. Create the drop, add variants, then mint per variant. |
| `PATCH { "dropType": … }` on a drop with **no** variants | Allowed (also `null` to clear) |
| `PATCH { "dropType": … }` on a drop **with** variants (archived count) | `409 PRODUCTS_DROP_TYPE_LOCKED` |

**Every product response** (`GET /products`, `GET /products/:id`,
`GET /admin/products/:id`, create, update) now includes:

```json
{
  "dropType": { "code": "T_SHIRT", "name": "T-Shirt", "variantMode": "REQUIRED" },
  "variants": [
    {
      "id": "…",
      "variantCode": "123456780000-M-BLK",
      "label": "M / Black",
      "optionName": "size/color",
      "optionValue": "M/BLK",
      "options": [
        { "dimension": "size",  "value": "M",   "label": "M",     "hexCode": null },
        { "dimension": "color", "value": "BLK", "label": "Black", "hexCode": "#1A1A1A" }
      ],
      "totalSupply": 100,
      "isActive": true
    }
  ]
}
```

`dropType` is `null` for legacy drops. `id`, `label`, `optionName`,
`optionValue` are unchanged, so existing clients keep working; the other
fields are new.

---

## 7. Variants API

Base path `/api/v1/admin/products/:id/variants`.

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/` | `drop:read` (org-scoped, like the drop detail screen) | Active variants; `?includeArchived=true` for all |
| `POST` | `/` | `drop:manage` 🌐 | Create an explicit list — all or nothing |
| `POST` | `/generate` | `drop:manage` 🌐 | Every combination of chosen values; supports `dryRun` |
| `PATCH` | `/:variantId` | `drop:manage` 🌐 | Label, position, supply, active flag |
| `DELETE` | `/:variantId` | `drop:manage` 🌐 | Delete — or archive, if anything points at it |

🌐 = platform-wide grant (`globalOnly`), same as every other catalog write.

**Before any create/generate,** the drop must: have a type (`400
PRODUCTS_DROP_TYPE_REQUIRED`), whose mode is not `NONE` (`400
PRODUCTS_VARIANTS_NOT_ALLOWED`), and be `DRAFT` or `REJECTED` (`409
PRODUCTS_DROP_NOT_EDITABLE`).

### The variant object

```json
{
  "id": "…",
  "publicCode": "dvr0h2k9…",
  "variantCode": "123456780000-M-BLK",
  "label": "M / Black",
  "options": [
    { "dimension": "size",  "dimensionLabel": "Size",  "value": "M",   "label": "M",     "hexCode": null },
    { "dimension": "color", "dimensionLabel": "Color", "value": "BLK", "label": "Black", "hexCode": "#1A1A1A" }
  ],
  "optionName": "size/color",
  "optionValue": "M/BLK",
  "position": 3,
  "totalSupply": 100,
  "mintedUnits": 0,
  "isActive": true,
  "archived": false,
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Field | Notes |
|---|---|
| `variantCode` | Built from the type's pattern. Unique across the whole platform. If two combinations would spell the same code (rare — only when optional dimensions share value codes), the second gets `-2` |
| `label` | Defaults to the value labels joined by ` / ` |
| `options[].label`, `hexCode` | **Snapshots** taken at creation. Renaming "Black" on the type later does not change what an existing variant (and its orders) says |
| `totalSupply` | Per-variant cap, or `null` = drawn from the drop's total |
| `mintedUnits` | Units minted for this variant so far |

### Option values

In both create and generate, an option value is either:

- a **value code**: `"M"`, `"blk"` (case-insensitive), or a number `5`; or
- for a dimension with `allowCustomValues`, a **custom value**:
  `{ "code": "SND", "label": "Sand", "hexCode": "#C2B280" }`.
  It exists only on this drop's variant — it is not added to the type.
  `hexCode` is accepted only on a `COLOR` dimension.

### `POST /variants` — an explicit list

```json
{
  "variants": [
    { "options": { "size": "M", "color": "BLK" }, "totalSupply": 50 },
    { "options": { "size": "M", "color": { "code": "SND", "label": "Sand", "hexCode": "#C2B280" } },
      "label": "M / Sand (tour exclusive)" }
  ]
}
```

- Up to **200** variants per call.
- **All or nothing** — one bad variant and nothing is written. The `400`
  lists every problem with its index:

```json
{
  "error": {
    "code": "PRODUCTS_VARIANT_INVALID_OPTIONS",
    "message": "One or more variants break the rules of this drop type.",
    "details": {
      "dropType": "T_SHIRT",
      "problems": [
        { "index": 1, "dimension": "color", "rule": "missing-required", "message": "Color is required for this T_SHIRT variant." }
      ]
    }
  }
}
```

- A combination the drop already has → `409 PRODUCTS_VARIANT_DUPLICATE`
  (`details.existing` lists the codes). The same combination twice in one
  request → `409` too.
- A combination that exists but is **archived** is restored instead of
  duplicated (keeps its old code, label and supply).
- Response `201` — the created/restored variants.

### `POST /variants/generate` — every combination

```json
{
  "select": {
    "format":   ["SINGLE", "PACK", "SET"],
    "packSize": [5, 10]
  },
  "totalSupplyEach": 100,
  "dryRun": true
}
```

Builds every combination of the selected values (3 × 2 = 6 here), then:

1. **Drops dimensions a rule forbids** for that combination —
   `SINGLE × 5` becomes plain `SINGLE`, not an error.
2. **Merges duplicates** that creates (`SINGLE × 5` and `SINGLE × 10` are both `SINGLE`).
3. **Skips** combinations the rules still refuse, and says why.
4. Leaves out combinations the drop **already has** (so it's safe to re-run),
   and restores archived ones.

Response (`200` on a dry run — nothing written; `201` otherwise):

```json
{
  "data": {
    "dryRun": true,
    "created": [
      { "variantCode": "123456780000-SINGLE", "label": "Single Card", "totalSupply": 100, "options": [ … ] },
      { "variantCode": "123456780000-PACK-5", "label": "Pack / 5 cards", "totalSupply": 100, "options": [ … ] },
      { "variantCode": "123456780000-PACK-10", "label": "Pack / 10 cards", "totalSupply": 100, "options": [ … ] },
      { "variantCode": "123456780000-SET", "label": "Complete Set", "totalSupply": 100, "options": [ … ] }
    ],
    "revived": [],
    "existing": [],
    "skipped": []
  }
}
```

| Key | Meaning |
|---|---|
| `created` | New variants — previews on a dry run, full variant objects otherwise |
| `revived` | Archived variants restored because their combination was selected again |
| `existing` | Combinations the drop already has; untouched |
| `skipped` | `{ options, problems }` — refused by the rules (e.g. a required dimension not selected) |

**The 200 limit.** The count is taken *before* rules prune anything (the 6
above). Over 200, the call is refused with `400
PRODUCTS_VARIANT_GENERATE_TOO_LARGE` — never cut short, so nothing is
silently left out. Split the selection, e.g. one color group per call.

Only selected dimensions appear in combinations. To get a combination
*without* an optional dimension (an action figure that is `LIMITED` with no
`variant`), use a second generate call or `POST /variants`.

### `PATCH /variants/:variantId`

```json
{ "label": "M / Black — Tour", "position": 0, "totalSupply": 120, "isActive": false }
```

Allowed **in any drop status** — none of these change *what* the variant is.

- `totalSupply` cannot go below `mintedUnits`, and capped variants together
  cannot exceed the drop's `totalSupply` (when the drop declares one).
- `isActive: false` stops new units being minted for it; it stays visible
  in history.
- Options cannot be edited — they are the variant's identity, and orders and
  units point at it. Remove it and create a new one.
- An archived variant cannot be patched; select its combination again to
  restore it.

### `DELETE /variants/:variantId`

Only while the drop is `DRAFT` or `REJECTED`.

```json
{ "data": { "outcome": "deleted", "variant": null } }
{ "data": { "outcome": "archived", "variant": { …, "archived": true } } }
```

**Deleted** outright when nothing references it; **archived** when any unit,
price, order or wishlist entry does — those records must keep meaning what
they meant.

---

## 8. Minting and submitting — what changed

Both endpoints are unchanged in shape; they just check the variant rules too.

### Submitting for review — `POST /api/v1/admin/releases`

| Drop | Result |
|---|---|
| `REQUIRED` type with no active variant | `400 PRODUCTS_VARIANTS_REQUIRED` — add variants first |
| Anything else | As before (including the auto-approval of ownerless drops) |

### Minting — `POST /api/v1/admin/products/:id/skus`

The approval gate runs **first** and is unchanged. Then:

| Request | Result |
|---|---|
| `REQUIRED` type, no `variantId` | `400 PRODUCTS_VARIANTS_REQUIRED` — every T-shirt unit has a size |
| `NONE` type, with a `variantId` | `400 PRODUCTS_VARIANTS_NOT_ALLOWED` |
| Variant archived or `isActive: false` | `400 PRODUCTS_VARIANT_INACTIVE` |
| Variant has `totalSupply` and minted + `count` would exceed it | `400 PRODUCTS_VARIANT_SUPPLY_EXCEEDED` |
| Legacy (untyped) drop, or `OPTIONAL` type | As before |

The drop-wide `totalSupply` cap inside the mint is unchanged and remains the
authority; the per-variant check is a pre-check.

---

## 9. The validation rules

**Per variant** — options are refused unless:

1. Every dimension exists on the type and isn't archived.
2. Every value is in the list (and not archived) — or the dimension allows
   custom values, in which case the code is 1–12 letters/digits.
3. Every required dimension has a value, after `require`/`forbid` rules.
4. No forbidden dimension has a value; no `exclude` rule matches.
5. At least one option.
6. A `hexCode` only on a `COLOR` dimension, and only a valid hex.

**Per drop:**

7. No duplicate combinations — refused in the request, and by the database
   (`unique (productId, optionsKey)`) even under concurrent requests.
8. `variantCode` is unique platform-wide (database-enforced).
9. `NONE` type → no variants. `REQUIRED` type → ≥ 1 active variant to submit.
10. Capped variant supplies ≤ the drop's `totalSupply` (when it is > 0).

**Per mint:** see §8.

---

## 10. What can change, and when

### On a drop

| Drop status | Add / remove variants | Edit label, position, supply, active | Change `dropType` |
|---|---|---|---|
| `DRAFT`, `REJECTED` | ✅ | ✅ | ✅ only if it has no variants |
| `SUBMITTED`, `IN_REVIEW` | ❌ `409` | ✅ | ✅ only if it has no variants |
| `APPROVED` and later | ❌ — see below | ✅ | ✅ only if it has no variants |

Why: the owner approves a drop **with its variants**. Adding a size after
approval would sell something the owner never signed off.

**To change variants after submitting or approving:**

1. Reject the review — `POST /admin/releases/:approvalId/decision` with
   `{ "status": "REJECTED", "comment": "<reason>" }`. The drop becomes
   `REJECTED`, which is editable.
   - Review still **pending**: the owner, or an administrator, can reject it.
   - Review already **approved**: only a holder of
     `release-approval:override` (HITBOX_SYSTEM_ADMIN) can turn it into a
     rejection. Nobody can override a review *into* an approval.
   - A rejection sets `Drop.status` to `REJECTED` unconditionally — on a
     drop that is already `PUBLISHED`/`ACTIVE` too. Change variants before
     publishing wherever possible.
2. Add / remove variants.
3. Submit again — `POST /admin/releases` opens the next version, and the owner
   approves the new set.

(*Reopen* is not the way: it puts the drop back to `SUBMITTED`, which is not
editable.)

### On a drop type (shared by many drops)

| Change | Allowed? | Effect on existing drops |
|---|---|---|
| Add a value or an optional dimension | ✅ always | None |
| Rename a value / change its hex | ✅ | None — variants keep their snapshot |
| Archive a value or dimension | ✅ (not if a rule names the dimension) | Existing variants keep it; new ones can't use it |
| Add a required dimension, or change rules | ✅, bumps `version` | **Never re-checked.** New rules apply to variants created afterwards |
| Change `variantMode` | Only while no drop uses the type (`409` otherwise) | — |
| Deactivate (`isActive: false`) | ✅ | Can't be picked for new drops; existing drops keep working |

---

## 11. Errors

Every error uses the standard envelope (`error.code`, `error.message`,
`error.details`).

| Status | Code | When |
|---|---|---|
| `400` | `PRODUCTS_DROP_TYPE_INVALID` | Bad type definition: rule naming an unknown dimension, hex on a non-COLOR dimension, dimension in a `NONE` type, archiving a dimension a rule uses |
| `400` | `PRODUCTS_DROP_TYPE_REQUIRED` | Variant write on a drop with no type |
| `400` | `PRODUCTS_VARIANT_INVALID_OPTIONS` | Rules 1–6; `details.problems[]` lists each with `index`, `dimension`, `rule`, `message` |
| `400` | `PRODUCTS_VARIANTS_NOT_ALLOWED` | Variant on a `NONE` type (create or mint) |
| `400` | `PRODUCTS_VARIANTS_REQUIRED` | `REQUIRED` type: submitting with no variant, minting without `variantId`, or inline `skus` at create |
| `400` | `PRODUCTS_VARIANT_SUPPLY_EXCEEDED` | Variant supplies over the drop's, supply below minted, or a mint over the variant's cap |
| `400` | `PRODUCTS_VARIANT_INACTIVE` | Minting for, or patching, an archived/inactive variant |
| `400` | `PRODUCTS_VARIANT_GENERATE_TOO_LARGE` | More than 200 combinations; `details.combinations` |
| `404` | `PRODUCTS_DROP_TYPE_NOT_FOUND` | Unknown type code (or inactive, when creating a drop) |
| `404` | `PRODUCTS_DIMENSION_NOT_FOUND` / `PRODUCTS_DIMENSION_VALUE_NOT_FOUND` | Unknown dimension / value on the type |
| `404` | `PRODUCTS_VARIANT_NOT_FOUND` | Variant isn't on this drop |
| `409` | `PRODUCTS_DROP_TYPE_CODE_TAKEN` | Type code already exists |
| `409` | `PRODUCTS_DROP_TYPE_LOCKED` | `variantMode` change on a used type; `dropType` change on a drop with variants |
| `409` | `PRODUCTS_DROP_NOT_EDITABLE` | Adding/removing variants outside `DRAFT`/`REJECTED` (§10 explains how to unlock) |
| `409` | `PRODUCTS_VARIANT_DUPLICATE` | Combination already exists, or appears twice in the request |
| `422` | `VALIDATION_ERROR` | Malformed body (bad code format, unknown field, …) |

---

## 12. Backward compatibility

Nothing existing breaks.

| Existing thing | After this change |
|---|---|
| Drops created before drop types | `dropType: null`, no rules apply, everything works as before |
| `POST /admin/products` without `dropType` | Still accepted — creates a legacy drop |
| Existing `DropVariant` rows | Migration gave each an `optionsKey` (`legacy:<name>=<value>`) and one option row with its original pair |
| `optionName` / `optionValue` | Kept on every variant. New variants fill them as `size/color` / `M/BLK` |
| `Sku.variantId`, `DropPrice.variantId`, `Order.variantId`, `WishlistItem.variantId` | Unchanged |
| `skuCode` format | Unchanged |
| Approval gate on minting | Unchanged |
| Product responses | Gain `dropType` and richer `variants[]`; nothing removed |

---

## 13. Data model

All in `packages/products/prisma/products.prisma`; migration
`20261007100000_drop_types_and_variants`. Additive — no column dropped or
retyped.

```
DropType ──< DropTypeDimension ──< DropTypeDimensionValue
   │                                  (code, label, hexCode)
   │ 0..1
   ▼
 Drop ──< DropVariant ──< DropVariantOption
          (variantCode,     (dimensionCode, valueCode,
           optionsKey)       labels + hexCode snapshot)
```

| Model | Key fields | Uniques |
|---|---|---|
| `DropType` | `code`, `variantMode`, `variantCodePattern`, `rules` (JSON), `version`, `isActive` | `code` |
| `DropTypeDimension` | `code`, `label`, `required`, `allowCustomValues`, `displayType`, `position`, `archivedAt` | `(dropTypeId, code)` |
| `DropTypeDimensionValue` | `code`, `label`, `hexCode`, `position`, `archivedAt` | `(dimensionId, code)` |
| `DropVariantOption` | `dimensionCode/Label`, `valueCode/Label`, `hexCode`, `position` | `(variantId, dimensionCode)` |
| `Drop` *(new fields)* | `dropTypeId?`, `dropTypeVersion?` | — |
| `DropVariant` *(new field)* | `optionsKey` — `color=BLK\|size=M`, sorted | `(productId, optionsKey)` |

New enums: `VariantMode` (`NONE`, `OPTIONAL`, `REQUIRED`),
`DimensionDisplayType` (`TEXT`, `COLOR`). `ResourceType` gained
`DROP_TYPE` for the new permission.

**Why a child table for options, not JSON:** each option row can be indexed
and queried ("stock of every Black variant"), and the database guarantees
one value per dimension.

**Why `optionsKey`:** a unique index can't span child rows, so the
combination is flattened into one canonical string the database can enforce.

---

## 14. Where the code lives

Everything is inside `@hitbox/products`, which owns drops and variants.
Other modules ask it questions through injected ports — no cross-module
imports.

```
packages/products/src/
  drop-type/
    rules.ts                  ← the rule engine: pure functions, no database
    drop-type.dto.ts          ← request validation
    drop-type.repository.ts   ← the only Prisma access for types
    drop-type.service.ts      ← type admin + the "don't break existing drops" rules
    drop-type.controller.ts
  variant/
    variant.dto.ts
    variant.repository.ts     ← the only Prisma access for variants
    variant.service.ts        ← create / generate / edit / remove
    variant.controller.ts
  domain/variant-policy.adapter.ts   ← answers skus (mint) and releases (submit)
  module.ts                   ← routes: /admin/products/:id/variants, createDropTypesRouter()

packages/skus/src/domain/interfaces/variant-policy.interface.ts       ← ISkuVariantPolicy
packages/releases/src/domain/interfaces/variant-policy.interface.ts   ← IReleaseVariantPolicy
apps/backend/src/bootstrap.ts   ← wires productsModule.variantPolicy into both
apps/backend/src/routes.ts      ← mounts /admin/drop-types
packages/shared/database/prisma/seed-drop-types.ts   ← the built-in types
packages/products/tests/variant-rules.test.ts        ← rule-engine tests
```

Events on the shared bus: `products.variant.created`,
`products.variant.updated`, `products.variant.archived`,
`products.drop-type.created`, `products.drop-type.updated`.

---

## 15. Setup on a new environment

From `packages/shared/database`:

```bash
pnpm db:deploy
```

```bash
pnpm db:seed:authz
```

```bash
pnpm db:seed:drop-types
```

1. `db:deploy` applies the migration (tables, enums, and the backfill of
   existing variants).
2. `db:seed:authz` registers `drop-type:manage:global` and grants it to
   `HITBOX_SYSTEM_ADMIN`.
3. `db:seed:drop-types` creates the built-in types. Safe to re-run: it only
   adds what's missing and never overwrites an admin's edits.

---

## 16. Frontend checklist

- [ ] Drop form: first step is a type picker from `GET /drop-types`; send `dropType` on create.
- [ ] Hide the inline `skus` block for `REQUIRED` types.
- [ ] Variant step: render each dimension from the type; show swatches from `hexCode` when `displayType` is `COLOR`; offer a "custom value" input when `allowCustomValues`.
- [ ] Call `generate` with `dryRun: true` first and show `created` / `skipped` / `existing`, then confirm with `dryRun: false`.
- [ ] Show `details.problems[]` next to the matching variant row and dimension.
- [ ] Lock variant add/remove when the drop isn't `DRAFT`/`REJECTED`; explain that rejecting the review unlocks it (§10).
- [ ] Mint screen: for a `REQUIRED` type, make the variant picker mandatory and show `mintedUnits / totalSupply` per variant.
- [ ] Mint is still disabled until the drop is approved (unchanged).
- [ ] Type admin screens (System Admin only): gate on `drop-type:manage:global` from `GET /authz/me`.

---

## 17. Not built

| Not built | Note |
|---|---|
| Making `dropType` mandatory on create | Optional today so existing clients keep working. Flip it once the frontend ships the type picker |
| Per-organization (brand-private) types | Types are platform-wide. Add `organizationId` to `DropType` if brands need their own |
| Variant-level images | `DropImage` is drop-level; a nullable `variantId` would add it |
| Editing a variant's options | Deliberately refused — remove and recreate |
| Auto-mapping legacy drops to a type | Legacy drops stay untyped; set `dropType` by `PATCH` (only while they have no variants) |
| Audit-trail entries for type/variant changes | Changes publish bus events; they are not yet in the audit log |
