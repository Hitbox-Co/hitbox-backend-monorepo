# Frontend brief — Artist drop review screen

> Hand this to the frontend team or agent as-is. Every field below is what the
> API actually returns today; nothing here is aspirational.

## What to build

An artist signs in and currently has **no way to open a drop**. They get asked to
approve one and have nowhere to look at it. Build two screens:

1. **Review queue** — the drops waiting on this artist.
2. **Drop review detail** — the drop's images, its details, the review history,
   and the Approve / Reject actions.

These already exist on the backend. Nothing new is needed server-side.

---

## 1. Review queue

```
GET /api/v1/admin/releases?latestOnly=true&status=PENDING&page=1&limit=20
```

Query params: `status`, `complianceStatus`, `productId`, `approverId`,
`latestOnly` (send `true` — one row per drop, the newest version), `page`,
`limit` (max 100).

Returns `{ page, limit, total, items: ReleaseApprovalListItem[] }`. The list is
already narrowed to what the caller may see — do **not** send an organization id
to filter it; the server resolves scope from the caller's grant and ignores
anything the client sends.

Each item carries what the row needs:

| Field | Use |
| --- | --- |
| `id` | the approval id — the route param for everything below |
| `productId`, `product.name`, `product.groupCode` | title and code |
| `status` | `PENDING` / `APPROVED` / `REJECTED` |
| `version` | a drop can be reviewed more than once |
| `authority` | `ARTIST` / `ORGANIZATION` / `PLATFORM` — who must sign off |
| `requiredArtistName`, `requiredOrganizationName` | who that is, by name |
| `product.isAgeSpecific`, `product.minimumAge`, `product.oddsDisclosureRef` | the three compliance facts |
| `comment` | the submitter's note to the artist |
| `createdAt`, `decidedAt` | waiting since / decided when |

Empty state: "Nothing is waiting on you." — not an error.

---

## 2. Drop review detail

Call **both** of these for the screen:

```
GET /api/v1/admin/releases/{approvalId}     → the review
GET /api/v1/admin/products/{productId}      → the drop itself, with images
```

### The review — `GET /admin/releases/{approvalId}`

Everything in the list item, plus:

- `history[]` — every prior version, newest first: `version`, `status`,
  `comment`, `decidedAt`, `reopenReason`, `legalComplianceAccepted`. Render as a
  timeline; a re-submitted drop's rejection note is the first thing the artist
  needs to read.
- **`canApprove`**, **`canReject`**, `canReopen` — booleans.
- `approveBlockedReason`, `blockedReason` — human-readable strings, already
  written for display. Show them verbatim.
- `legalComplianceStatement` — the exact wording to put beside the checkbox.
- `legalComplianceVersionRequired` — do not display; the server records it.

**Drive the two buttons from `canApprove` and `canReject` separately.** They are
deliberately not one flag: an administrator looking at a brand's drop may reject
it and may not approve it. When a button is disabled, show the matching
`*BlockedReason` rather than hiding the button — the artist should be able to see
why.

### The drop — `GET /admin/products/{productId}`

```jsonc
{
  "data": {
    "id": "...", "groupCode": "HB-1042", "name": "Artist Prod",
    "description": "...", "category": "...", "rarity": "...", "vertical": "...",
    "status": "SUBMITTED", "complianceStatus": "PENDING",
    "totalSupply": 150, "purchaseLimit": 2,
    "releaseStart": "2026-09-30T...", "releaseEnd": null, "publishedAt": null,
    "isAgeSpecific": false, "minimumAge": null, "oddsDisclosureRef": null,
    "artistId": "...", "artistName": "Codershub", "organizationId": "...",
    "images": ["https://...", "https://..."],        // ordered, primary first
    "price": { "amount": "49.00", "currency": "USD", "isFree": false },
    "variants": [{ "id": "...", "label": "Size M", "optionName": "size", "optionValue": "M" }],
    "performance": { /* sales figures */ },
    "skuUnits": { "page": 1, "limit": 20, "total": 150, "items": [ /* … */ ] }
  }
}
```

`images` is a plain array of URLs, **primary first** — use `images[0]` as the
hero and the rest as a gallery. It is `[]` when the drop has no artwork yet; say
so rather than rendering a broken image, because "no artwork" is itself
something the artist is being asked to approve.

If you need per-image metadata (alt text, explicit `isPrimary`, `position`,
`imageId`), call `GET /api/v1/admin/products/{productId}/images` instead, which
returns `{ imageId, assetId, url, storageRef, position, isPrimary, altText, createdAt }[]`.
`url` is null when no storage bucket is configured on that deployment.

Market pricing: `GET /api/v1/admin/products/{productId}/prices`.

**Surface `isAgeSpecific` / `minimumAge` / `oddsDisclosureRef` prominently.**
Those are the three things the approver is personally accountable for, and the
server refuses an approval of an age-restricted drop that carries no minimum
age.

An artist gets **403** on any write to `/admin/products/*` — catalog editing is
platform-only by design. Do not render edit controls for them.

---

## 3. Recording the decision

One endpoint. Status and note go together in the same call.

```
POST /api/v1/admin/releases/{approvalId}/decision
Content-Type: application/json
```

Approve:

```json
{ "status": "APPROVED", "comment": "Looks good", "acceptLegalCompliance": true }
```

Reject:

```json
{ "status": "REJECTED", "comment": "The cover art is the wrong version" }
```

### Rules that will bite you

1. **`acceptLegalCompliance: true` is mandatory when approving.** Render it as an
   **unticked** checkbox showing `legalComplianceStatement`. Never default it to
   ticked, never send it for a rejection. Omitting it on an approve is a `400`
   with code `RELEASES_LEGAL_ACCEPTANCE_REQUIRED`.
2. **`comment` is required when rejecting.** A drop bounced back with no reason
   costs the submitter a round trip. Validate it client-side before enabling the
   button.
3. **The body is strict.** Any field not in the list below is a `400`. Do not
   send `productId`, `version`, `authority`, or anything else you happen to have
   in state.
   Allowed: `status`, `comment`, `acceptLegalCompliance`, `complianceStatus`,
   `oddsDisclosureRef`.
4. **There is no PATCH for status.** `PATCH /admin/releases/{approvalId}` cannot
   change status and requires a capability artists do not hold — calling it will
   `403`. Everything goes through `POST /decision`.

Returns the updated `ReleaseApprovalDetail`. Re-render from the response rather
than refetching.

### Errors worth handling by name

| Code | Status | Meaning |
| --- | --- | --- |
| `RELEASES_LEGAL_ACCEPTANCE_REQUIRED` | 400 | The checkbox was not ticked |
| `RELEASES_COMPLIANCE_INCOMPLETE` | 400 | Age-restricted drop with no minimum age |
| `RELEASES_NOT_THE_APPROVER` | 403 | Not the party entitled to decide this one — show the message |
| `RELEASES_ALREADY_DECIDED` | 409 | Someone decided it first; refetch |

The `403` message is written for display. Show it rather than a generic
"Forbidden".

---

## Notes

- All routes are under `/api/v1/admin/...` and need the normal authenticated
  session. "Admin" is the URL prefix, not a role gate — an artist is a legitimate
  caller on every route above.
- Never send an `organizationId` to widen or filter a list. Scope comes from the
  caller's grant; anything the client sends is ignored.
- `GET /authz/me` returns the caller's effective permissions if you want to
  drive navigation from capabilities rather than guessing from a role name.
