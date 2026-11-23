# Addresses — API

The buyer's saved addresses. This API feeds the **address book** screen, the
**address picker** in the checkout sheet, and the add/edit address form.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/users/me/addresses` | Bearer | My addresses, default first, then newest |
| POST | `/users/me/addresses` | Bearer | Save a new address |
| GET | `/users/me/addresses/:id` | Bearer | One address |
| PATCH | `/users/me/addresses/:id` | Bearer | Change some fields |
| DELETE | `/users/me/addresses/:id` | Bearer | Delete (archive) it |
| POST | `/users/me/addresses/:id/default` | Bearer | Make it my default |

Base path: `/api/v1/users/me/addresses`. Code: `packages/users`
(`AddressController`, `AddressService`, `AddressRepository`, `dto/address.dto.ts`,
`domain/address-rules.ts`). It sits beside the profile routes in
[users-api.md](users-api.md).

The address you pick at checkout is **copied onto the order**
([orders-api.md → BuyerAddress](orders-api.md#buyeraddress)). Editing or
deleting a saved address later never changes an order already placed.

---

## Authentication

Every endpoint needs a signed-in user: the Clerk session JWT as
`Authorization: Bearer <token>`. See [auth-api.md](auth-api.md). No extra
permission is needed: every call is scoped to the caller's own id.

**Someone else's address is a `404 USERS_ADDRESS_NOT_FOUND`**, the same answer
as an address that does not exist or was deleted, so the API cannot be used to
find out whether another person's address id is real.

Rate limits, per signed-in user, per minute: **120** reads, **30** writes
(create, change, delete, set default). Over the limit: `429 RATE_LIMITED`.

---

## Shape

### `Address`

```jsonc
{
  "id": "2f6d7c8b-4a1e-4b9c-8d3f-5e6a7b8c9d0e",
  "label": "Home",                    // "Home" | "Work" | "Other"
  "recipientName": "Arjun Singh",
  "line1": "12 MG Road",
  "line2": "Flat 4B",                 // null if not set
  "city": "Bengaluru",
  "state": "KA",                      // null if not set (see "Per-country rules")
  "postalCode": "560001",
  "countryCode": "IN",                // ISO 3166-1 alpha-2, upper case
  "phone": "+919800000000",           // null if not set
  "isDefault": true,                  // exactly one address per user is the default
  "usage": "BOTH",                    // "SHIPPING" | "BILLING" | "BOTH"
  "createdAt": "2026-11-20T09:00:00.000Z"
}
```

This is orders' `BuyerAddress` (recipientName … phone) plus `id`, `label`,
`isDefault`, `usage` and `createdAt`.

---

## Endpoints

### `GET /api/v1/users/me/addresses`

```jsonc
{ "data": [ Address, … ] }            // [] when none; default first, then newest
```

Archived (deleted) addresses are never listed. There is no paging: a user has at
most 10.

### `POST /api/v1/users/me/addresses`

| Field | Rules | Default |
|---|---|---|
| `label` | `Home` `Work` `Other` | required |
| `recipientName` | 1–100 chars, trimmed | required |
| `line1` | 1–200 chars, trimmed | required |
| `line2` | up to 200 chars; blank or `null` = not set | `null` |
| `city` | 1–100 chars | required |
| `state` | up to 100 chars, stored upper case. **Required, as the ISO code, for `IN` and `US`** | `null` |
| `postalCode` | 2–20 chars; per-country format below | required |
| `countryCode` | ISO 3166-1 alpha-2; lower case is accepted and upper-cased | required |
| `phone` | `+` optional, digits, spaces, `()-.`; 5–20 chars | `null` |
| `usage` | `SHIPPING` `BILLING` `BOTH` | `BOTH` |

Unknown fields are rejected (`isDefault` is not settable here: use `/default`).

```json
{
  "label": "Home",
  "recipientName": "Arjun Singh",
  "line1": "12 MG Road",
  "line2": "Flat 4B",
  "city": "Bengaluru",
  "state": "KA",
  "postalCode": "560001",
  "countryCode": "IN",
  "phone": "+919800000000"
}
```

**`201 Created`**: the first address a user saves becomes their default.

```json
{
  "data": {
    "id": "2f6d7c8b-4a1e-4b9c-8d3f-5e6a7b8c9d0e",
    "label": "Home",
    "recipientName": "Arjun Singh",
    "line1": "12 MG Road",
    "line2": "Flat 4B",
    "city": "Bengaluru",
    "state": "KA",
    "postalCode": "560001",
    "countryCode": "IN",
    "phone": "+919800000000",
    "isDefault": true,
    "usage": "BOTH",
    "createdAt": "2026-11-23T09:00:00.000Z"
  }
}
```

| Status | Code | When |
|---|---|---|
| 409 | `USERS_ADDRESS_LIMIT_REACHED` | Already 10 addresses. `details.limit` is `10`. Deleted ones do not count |
| 422 | `VALIDATION_ERROR` | A field broke a rule. `details` lists every field at once |
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |
| 429 | `RATE_LIMITED` | Over 30 writes a minute |

### `GET /api/v1/users/me/addresses/:id`

```jsonc
{ "data": Address }
```

`404 USERS_ADDRESS_NOT_FOUND`: no such address, not yours, deleted, or `:id` is
not a uuid.

### `PATCH /api/v1/users/me/addresses/:id`

Send only the fields to change. `line2`, `state` and `phone` accept `null` to
clear them. An empty body or an unknown field is a `422`.

```json
{ "line2": null, "phone": "+919811111111" }
```

```jsonc
{ "data": Address }                   // 200
```

The server merges your fields over the saved address and checks the **whole
result** against the per-country rules. So `{ "countryCode": "US" }` alone is
refused while the saved PIN code and state are Indian: send the country, state
and postal code together.

Errors: `404 USERS_ADDRESS_NOT_FOUND`, `422 VALIDATION_ERROR`.

### `DELETE /api/v1/users/me/addresses/:id`

`204 No Content`. This **archives** the address (soft delete): it disappears from
the list and cannot be picked at checkout, but the row is kept so nothing that
copied it breaks. An old order's address does not change.

If it was the default, the **newest remaining** address becomes the default, so a
user with any address always has exactly one default.

Errors: `404 USERS_ADDRESS_NOT_FOUND` (deleting twice is a 404 the second time).

### `POST /api/v1/users/me/addresses/:id/default`

No body. Makes this the default and clears it on the previous one, in one
transaction. Safe to repeat.

```json
{
  "data": {
    "id": "5a9c1d2e-7b3f-4c8d-9e0a-1b2c3d4e5f6a",
    "label": "Work",
    "recipientName": "Arjun Singh",
    "line1": "1 Residency Road",
    "line2": null,
    "city": "Bengaluru",
    "state": "KA",
    "postalCode": "560025",
    "countryCode": "IN",
    "phone": null,
    "isDefault": true,
    "usage": "SHIPPING",
    "createdAt": "2026-11-21T14:30:00.000Z"
  }
}
```

Errors: `404 USERS_ADDRESS_NOT_FOUND`.

---

## Per-country rules

`state` and `postalCode` are checked against `countryCode`. Strict for the two
countries HitBox taxes, because the billing address's country and state choose
the tax rate on the invoice.

| Country | `postalCode` | `state` |
|---|---|---|
| `IN` | 6 digits, first not `0`. Spaces are removed (`560 001` → `560001`) | **Required.** ISO 3166-2 code of a state or union territory: `KA`, `MH`, `DL`, … |
| `US` | `12345` or `12345-6789` | **Required.** 2-letter code: 50 states, `DC`, `PR`, `VI`, `GU`, `AS`, `MP` |
| anything else | 2–12 letters, digits, spaces, hyphens (stored upper case) | Optional, free text |

`countryCode` must be an assigned ISO 3166-1 alpha-2 code (`ZZ` is refused).

A `422` looks like this, one entry per broken field:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "path": "postalCode", "message": "An Indian PIN code is 6 digits and does not start with 0, e.g. \"560001\".", "code": "custom" },
      { "path": "state", "message": "An Indian address needs its ISO state or union-territory code, e.g. \"KA\".", "code": "custom" }
    ]
  }
}
```

---

## How checkout uses addresses

`POST /checkout` and `POST /checkout/quote` take `shippingAddressId` and
`billingAddressId` ([payments-api.md](payments-api.md)). Both run **one check**
(`AddressService.resolveForCheckout`, the same code that answers 404 on these
routes):

| The id is… | Result |
|---|---|
| not the buyer's, or unknown | **Ignored**, as if it was not sent (no error; the order gets no address) |
| the buyer's, but deleted | `400 USERS_ADDRESS_ARCHIVED` |
| the buyer's, but saved for the other side (`SHIPPING`-only as billing, or `BILLING`-only as shipping) | `400 USERS_ADDRESS_USAGE_MISMATCH` |
| the buyer's and live | Used. Its lines are copied onto the order |

The ids and the orders' own copy are re-checked inside the order transaction, so
an address deleted in the same instant is skipped rather than copied.

The **billing** address's country (and, for the US, state) decides the tax. See
[payments-api.md → Billing address rule](payments-api.md#billing-address-rule).

---

## Known limitations

- **No separate default per side.** There is one default; the app filters by
  `usage` itself when it wants a default shipping or billing address.
- **No label text beyond Home / Work / Other.**
- **Phone numbers are not verified**, only shape-checked.
- **`state` for countries other than IN and US is free text**, so do not assume
  it is a code.
- **The 10-address cap and the single default are enforced with a row lock on
  the user plus a unique database index.** Two devices saving at once queue up;
  the 11th save is a `409`, never a silent 11th row.
