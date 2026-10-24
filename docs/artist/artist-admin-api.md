# Artist administration API (HitBox staff)

> The staff side of an artist: the full profile, stats, the directory summary,
> and the actions that change an artist's record. Everything lives under
> **`/api/v1/admin/artists`**, alongside the directory the drop form's picker
> uses ([product-upload-api.md](../admin/product-upload-api.md#get-apiv1adminartists)).
>
> The artist's own screen is [artist-profile-api.md](artist-profile-api.md);
> their collections are [artist-collection/](../artist-collection/README.md).

---

## 1. Who can call what

| Routes | Needs | Who has it (seeded) |
|---|---|---|
| Directory: `GET /`, `GET /:artistId` | `drop:read` | Drop Managers, Brand Admins, System Admin |
| Staff reads: `GET /summary`, `GET /:artistId/profile`, `GET /:artistId/stats` | `brand-artist-record:read` **platform-wide** | System Admin (`brand-artist-record:manage:global`) |
| Staff writes: `PATCH /:artistId`, `POST /:artistId/{action}` | `brand-artist-record:update` **platform-wide** | System Admin |

"Platform-wide" means the grant has to be global. A Brand Admin's
`brand-artist-record:*:organization` and an artist's `:own` grant get
**403** here.

**Money needs one more grant.** Revenue, royalties and payout amounts are only
included when the caller also holds `payment-royalty:read` at global scope;
this is the dashboard's rule, so seeing an artist never implies seeing what
they earn. Without it the money keys are **left out** (not zeroed), and the
response says `"moneyVisible": false`.

Money is always a map per currency, `{ "USD": "190.00", "INR": "11495.00" }`,
with values as strings. It's never one total: there's no exchange rate in the
system.

---

## 2. Routes

| # | Route | What |
|---|---|---|
| 1 | `GET /admin/artists` | Directory: list, filter and **sort** (3) |
| 2 | `GET /admin/artists/summary` | Directory tiles in one call (4) |
| 3 | `GET /admin/artists/:artistId` | Directory row (picker) |
| 4 | `GET /admin/artists/:artistId/profile` | **Full profile**: bio, cover, account, compliance, payout and tax status (5) |
| 5 | `GET /admin/artists/:artistId/stats` | Sales, revenue, royalties, claims, followers over time, top drops (6) |
| 6 | `PATCH /admin/artists/:artistId` | Staff edit (7) |
| 7 | `POST /admin/artists/:artistId/activate` · `/deactivate` | Switch selling on/off (8) |
| 8 | `POST /admin/artists/:artistId/archive` · `/restore` | Archive / bring back (8) |
| 9 | `POST /admin/artists/:artistId/publish` · `/unlist` | Show on / hide from the public storefront (8) |

A drop list for one artist, **drafts and drops in review included**, is the
dashboard products list:
`GET /api/v1/admin/dashboard/products?artistId=<id>` (9).

---

## 3. `GET /admin/artists`: the directory

| Query | Values |
|---|---|
| `search` | Name or slug, case-insensitive |
| `organizationId` | One brand's roster |
| `isActive` | `true` / `false` |
| `isPublic` | `true` / `false` |
| `includeArchived` | `true` / `false` (default `false`) |
| `sort` | `name` (default, A–Z) · `newest` · `oldest` · `drops` · `collections` · `followers` (most first) |
| `page`, `limit` | `1`, `100` (max 200) |

**Fixed: `false` now means false.** These flags used to be parsed with
`Boolean(value)`, so `?isActive=false` returned the **active** artists. Now
only `true`/`false` (or `1`/`0`) are accepted, and anything else is a
validation error. "Inactive only" is `?isActive=false`, and "unlisted only" is
`?isPublic=false`.

Rows now carry `counts.followers` too:
`"counts": { "products": 4, "collections": 2, "followers": 9 }`. Ties in any
sort fall back to name and then id, so paging never repeats or skips a row.

The directory row still deliberately has **no account id**. It fills a picker
behind `drop:read`. The account is on the profile (5).

---

## 4. `GET /admin/artists/summary`

| Query | Values |
|---|---|
| `organizationId` | Optional: one brand's artists |
| `top` | How many best sellers to return, default 5, max 20 |

```json
{
  "data": {
    "total": 3,
    "active": 3,
    "inactive": 0,
    "public": 3,
    "unlisted": 0,
    "archived": 0,
    "newThisMonth": 0,
    "withoutAvatar": 3,
    "withoutBio": 0,
    "withoutAccount": 2,
    "withoutCompliance": 0,
    "moneyVisible": true,
    "topBySales": [
      { "artistId": "23ef4303-…", "name": "Kaze", "slug": "kaze", "avatarUrl": null,
        "orders": 19, "unitsSold": 19,
        "revenue": { "GBP": "196.00", "INR": "11495.00", "USD": "190.00" } }
    ]
  }
}
```

- Every count is of **live** (not archived) artists, except `archived`.
- `newThisMonth` counts artists created since the 1st of the current month (UTC).
- `withoutBio` counts an empty or whitespace-only bio as missing.
- `withoutAccount` counts invited artists who haven't signed up yet.
- `topBySales` is ranked by **units sold, all time**. Ranking by revenue would
  need adding currencies together. Artists with no sales aren't listed.
  `revenue` only appears with money, and the whole list is `null` if the
  reporting adapter isn't wired on this server.

One request replaces the four separate reads the tiles used to make.

---

## 5. `GET /admin/artists/:artistId/profile`

```json
{
  "data": {
    "id": "23ef4303-f877-4dc5-a375-ab4fe568b361",
    "publicCode": "art…",
    "name": "Kaze",
    "slug": "kaze",
    "bio": "…",
    "genre": "Pop",
    "avatarUrl": null,
    "coverUrl": "https://…/cover.png",
    "isPublic": true,
    "isActive": true,
    "archivedAt": null,
    "editable": true,
    "account": {
      "userId": "e62cf069-8949-4ed5-b007-d41784d31c62",
      "email": "kaze@example.com",
      "fullName": "Kaze",
      "isActive": true,
      "joinedAt": "2026-07-16T12:00:00.000Z"
    },
    "invitationId": null,
    "organization": { "id": "f3bb…", "name": "Kaze (solo)", "type": "ARTIST_INDIVIDUAL" },
    "brandLinks": [
      { "id": "…", "organizationId": "…", "organizationName": "Lumen Studios",
        "linkType": "PRIMARY", "startDate": "2026-07-01T00:00:00.000Z", "endDate": null, "isActive": true }
    ],
    "compliance": { "attested": true, "attestedAt": "2026-07-06T12:00:00.000Z", "attestedById": "05ac…" },
    "payouts": {
      "lastPayout": {
        "id": "5ea0…", "publicCode": "pyo…", "status": "PAID", "currency": "INR", "amount": "1124.55",
        "scheduledAt": "2026-09-25T13:00:00.000Z", "paidAt": "2026-09-28T13:00:00.000Z", "failureReason": null
      },
      "openBatches": 0,
      "failedBatches": 0,
      "outstanding": { "GBP": "27.00", "USD": "74.25" },
      "totalPaid": { "INR": "1124.55" }
    },
    "tax": {
      "documents": [
        { "id": "…", "documentType": "W9", "countryCode": "US", "status": "APPROVED",
          "expiresAt": null, "verifiedAt": "…", "backupWithholdingApplied": false }
      ],
      "hasApprovedDocument": true,
      "backupWithholding": false
    },
    "counts": { "drops": 4, "collections": 2, "followers": 9, "claims": 9 },
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

| Field | Notes |
|---|---|
| `account` | The artist's sign-in account. `null` while the invitation is unaccepted. **`account.userId` is the id for the audit log** (`GET /admin/audit/events?actorId=…`), so the Activity link no longer depends on the artist having a collection. `joinedAt` is when that account was created. |
| `editable` | Whether the artist can edit their own profile (active and not archived) |
| `brandLinks` | Commercial links to brands, newest first |
| `compliance.attestedById` | The staff member who attested |
| `payouts` | `openBatches` counts batches that are SCHEDULED or APPROVED. `amount`, `outstanding` and `totalPaid` only appear with money. |
| `tax` | Live documents only (superseded ones are left out). **Document numbers and files are never returned here.** |
| `counts.claims` | Every claim on the artist's units, revoked ones included. Stats (6) splits them. |
| `payouts`, `tax` | `null` if the reporting adapter isn't wired on this server |

`createdAt` is when the artist **record** was created, which is usually the
invitation. `account.joinedAt` is when the person signed up.

> **Social links.** `Artist` has no links, website or social columns, so
> there's nothing to return. Adding them is a schema change, and the artist's
> own edit form would need them too.

---

## 6. `GET /admin/artists/:artistId/stats`

| Query | Values |
|---|---|
| `period` | `week` · `month` · `year` (default) · `custom` |
| `from`, `to` | ISO dates, required for `custom`; `from` must be before `to` |
| `topDrops` | Default 5, max 20 |

```json
{
  "data": {
    "artistId": "23ef4303-…",
    "moneyVisible": true,
    "period": { "type": "year", "from": "2025-10-25T00:00:00.000Z", "to": "2026-10-25T00:00:00.000Z" },
    "sales": {
      "lifetime": { "orders": 19, "unitsSold": 19, "revenue": { "GBP": "196.00", "INR": "11495.00", "USD": "190.00" } },
      "period":   { "orders": 19, "unitsSold": 19, "revenue": { "…": "…" } },
      "trend": [ { "date": "2026-08-01", "value": 5 }, { "date": "2026-09-01", "value": 6 }, { "date": "2026-10-01", "value": 8 } ]
    },
    "royalties": {
      "earned":       { "GBP": "27.00", "INR": "1124.55", "USD": "74.25" },
      "paid":         { "INR": "1124.55", "GBP": "0.00", "USD": "0.00" },
      "outstanding":  { "GBP": "27.00", "USD": "74.25", "INR": "0.00" },
      "periodEarned": { "…": "…" }
    },
    "claims": { "lifetime": 9, "period": 9, "revoked": 0 },
    "followers": {
      "total": 9,
      "period": 9,
      "trend": [ { "date": "2026-08-01", "new": 3, "total": 3 }, { "date": "2026-09-01", "new": 6, "total": 9 } ]
    },
    "topDrops": [
      { "id": "…", "publicCode": "drp…", "name": "Kaze — Neon Nights Tour Tee", "status": "ACTIVE",
        "orders": 8, "unitsSold": 8, "revenue": { "USD": "80.00" } }
    ]
  }
}
```

| Block | Definition |
|---|---|
| `sales` | Orders on the artist's drops (`Drop.artistId`) in **PAID, PROCESSING, SHIPPED or DELIVERED**. Cancelled and refunded orders never count. Windowed on `paidAt`, when revenue is recognised. `unitsSold` sums `quantity`. |
| `sales.trend` | Units sold per bucket: per day for `week`, `month` and `custom` up to about 400 days, per month for `year` and longer custom ranges |
| `royalties` | The royalty ledger for this artist as payee. `earned` excludes reversed entries and is net of clawbacks; `paid` is status PAID; `outstanding` is accrued or batched but unpaid. Only appears with money. |
| `claims` | `lifetime` and `period` count live claims; `revoked` counts the revoked ones |
| `followers.trend` | **Followers over time**: each bucket gives `new` follows and the running `total` at the end of that bucket. Buckets with no new follows are skipped. |
| `topDrops` | Best sellers by units, **all time**. `revenue` only appears with money. |

A `400 ARTIST_STATS_UNAVAILABLE` means the reporting adapter isn't wired on
this server.

**Where the numbers come from.** Orders, the royalty ledger, payouts, tax,
claims and follows all belong to other modules. The artist module asks
through its own port (`IArtistInsights`), and `@hitbox/dashboard`, the
read-only reporting module, answers it, aggregating in SQL. The artist module
never queries those tables itself.

---

## 7. `PATCH /admin/artists/:artistId`

Send only what changes:

```json
{ "bio": "Tokyo-born street artist.", "genre": "STREET_ART", "reason": "Label asked for a bio update" }
```

| Field | Rules |
|---|---|
| `name` | 1–120 characters |
| `slug` | The public handle: 3–60 characters of lowercase letters, digits and single hyphens. Must be unused (`409 ARTIST_SLUG_TAKEN`). |
| `bio` | Up to 2000 characters; `""` or `null` clears it |
| `genre` | A code or label from `GET /artist/genres`; `null` clears it |
| `avatarUrl`, `coverUrl` | **Only `null`**: staff can take an image down. Putting one up is the artist's upload flow. |
| `complianceAttested` | `true` records that HitBox checked compliance, **now, by you**. Attesting again keeps the first attestation. `false` withdraws it. |
| `reason` | Optional, up to 500 characters, kept in the audit trail. A reason alone isn't a change. |

- The body is **strict**. `isActive`, `isPublic`, `organizationId`, `userId`
  and so on are refused: state changes have their own actions (8), and the
  account and organization links aren't editable here.
- Response: the full profile (5).
- If nothing actually differs, the profile comes back unchanged, and nothing
  is written or audited.
- An archived artist can't be edited (`409 ARTIST_ARCHIVED`).

---

## 8. State actions

`POST /admin/artists/:artistId/{action}` with an optional body
`{ "reason": "…" }` (up to 500 characters, audited). Response: the full
profile (5).

| Action | Sets | Refused when |
|---|---|---|
| `activate` | `isActive: true` | Already active (`409 ARTIST_STATE_UNCHANGED`) |
| `deactivate` | `isActive: false`, which also locks the artist's own editing (`editable: false`) | Already inactive |
| `archive` | `archivedAt: now` | Already archived (`409 ARTIST_ARCHIVED`) |
| `restore` | `archivedAt: null` | Not archived (`409 ARTIST_NOT_ARCHIVED`) |
| `publish` | `isPublic: true` | Already public; **inactive** (`409 ARTIST_INACTIVE`, activate first) |
| `unlist` | `isPublic: false` | Already unlisted |

- Every action except `restore` is refused on an archived artist
  (`409 ARTIST_ARCHIVED`): restore first.
- Each write is **guarded** on the state it expects. If someone else changed
  the artist in the meantime, the action is refused with
  `409 ARTIST_CHANGED` and nothing changes; reload.
- The artist's drops and collections are left as they are. These actions
  change the artist record only.

---

## 9. Drops by artist (admin): `GET /admin/dashboard/products`

The admin drop list now accepts two new query parameters:

| Query | Values |
|---|---|
| `artistId` | One artist's drops, **every status**: drafts, submitted, in review, approved, active, ended |
| `q` | Name or group code, case-insensitive |

The existing `status` and paging parameters also work. Rows now include
`publicCode`, `collectionId` and `isActive`. Use this for the artist page's
Drops tab instead of the public catalog (`GET /products?artistId=`), which
only shows live drops. The gate is unchanged: `drop:read`, filtered to the
caller's organizations.

---

## 10. Audit trail and events

Every staff change is audited, with persona group `hitbox_admin`, actor type
`HITBOX_ADMIN`, the role that passed as `actorRoleSnapshot`, and resource
`Artist`. Before and after snapshots are recorded, and `metadata` carries the
`reason` when given:

| Event | Severity | When |
|---|---|---|
| `artist.profile.update` | INFO | A PATCH changed name, handle, bio, genre or an image. `metadata.fields` lists which. |
| `artist.profile.compliance.attest` | WARNING | Compliance attested |
| `artist.profile.compliance.revoke` | WARNING | Attestation withdrawn |
| `artist.profile.activate` | INFO | |
| `artist.profile.deactivate` | WARNING | |
| `artist.profile.archive` | WARNING | |
| `artist.profile.restore` | INFO | |
| `artist.profile.publish` | INFO | |
| `artist.profile.unlist` | INFO | |

A PATCH that both edits and attests writes two rows that share one
`correlationId`. Find an artist's trail with
`GET /admin/audit/events?resourceType=Artist&resourceId=<artistId>`.

Bus events:

| Event | Payload |
|---|---|
| `artist.profile.updated` | `{ artistId, fields, by: "staff" }`, the same event the artist's own edits publish |
| `artist.profile.status-changed` | `{ artistId, action, isActive, isPublic, archivedAt }` |

---

## 11. Errors

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Bad query or body: an unknown field, a boolean that isn't `true`/`false`, a custom period without `from`/`to` |
| `400` | `ARTIST_GENRE_INVALID` | Unknown genre (`details.allowed`) |
| `400` | `ARTIST_STATS_UNAVAILABLE` | No reporting adapter on this server |
| `403` | `AUTHZ_FORBIDDEN` | No platform-wide `brand-artist-record` grant |
| `404` | `ARTIST_NOT_FOUND` | No such artist |
| `409` | `ARTIST_ARCHIVED` | Editing or acting on an archived artist |
| `409` | `ARTIST_NOT_ARCHIVED` | Restoring an artist that isn't archived |
| `409` | `ARTIST_INACTIVE` | Publishing an inactive artist |
| `409` | `ARTIST_STATE_UNCHANGED` | The action would change nothing |
| `409` | `ARTIST_SLUG_TAKEN` | Handle in use |
| `409` | `ARTIST_CHANGED` | Changed by someone else between read and write. Reload. |

---

## 12. Console checklist

- [ ] Directory filters send `isActive=false` / `isPublic=false` for "inactive only" / "unlisted only"; add a **Sort** control (`sort=`)
- [ ] Tiles: one `GET /admin/artists/summary` call instead of four counts; best sellers from `topBySales`
- [ ] Artist page header and About tab from `GET /:artistId/profile`; the Activity link uses `account.userId` (hide it when `account` is null)
- [ ] Stats tab from `GET /:artistId/stats` with a period picker; render money per currency; hide money cards when `moneyVisible` is false
- [ ] Drops tab from `GET /admin/dashboard/products?artistId=` (drafts included)
- [ ] Edit form → `PATCH`; "Take down avatar/cover" → `{ avatarUrl: null }`; "Attest compliance" → `{ complianceAttested: true }`
- [ ] Action menu → activate / deactivate / archive / restore / publish / unlist, with an optional reason box; show `409` messages as-is
- [ ] Show the action menu and edit button only to callers with the platform-wide grant (others get 403)

---

## 13. Code map

```
packages/artist/src/admin/
  constants/artist-admin.constant.ts   capabilities, error codes, audit + bus events, actions
  domain/artist-insights.port.ts       IArtistInsights: dashboard implements it
  dto/artist-admin.dto.ts              PATCH / action / stats / summary schemas, response types
  repository/artist-admin.repository.ts  staff select, guarded writes, summary counts (one query)
  service/artist-admin.service.ts      profile, stats, summary, update, state actions, audit
  controller/artist-admin.controller.ts
packages/artist/src/profile/dto/artist.dto.ts       directory: strict booleans, sort
packages/artist/src/module.ts                       routes on createAdminRouter
packages/dashboard/src/adapter/artist-insights.adapter.ts      the port's implementation
packages/dashboard/src/repository/artist-insights.repository.ts  the SQL
packages/dashboard/src/repository/dashboard.repository.ts      listProducts: artistId, q
apps/backend/src/bootstrap.ts                        insights + canSeeMoney wiring
packages/audit/src/domain/audit-event-catalog.ts     artist.profile.* events
packages/artist/tests/artist-admin.test.ts
packages/dashboard/tests/artist-insights.test.ts
```
