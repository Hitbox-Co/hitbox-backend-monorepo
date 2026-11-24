# Users — API

The signed-in user's own profile (Profile tab, Edit profile screen) and other
collectors' profiles (a collector's page), including the **public / private**
switch.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/users/me` | required | My full profile, with my stats |
| `PATCH` | `/api/v1/users/me` | required | Edit my profile, including `profileVisibility` |
| `GET` | `/api/v1/users/:id` | optional | A collector's profile (public **or** private) |
| `GET` | `/api/v1/users/handle/:handle` | optional | The same, found by handle |
| `GET` `POST` `PATCH` `DELETE` | `/api/v1/users/me/addresses…` | required | My address book: see [addresses-api.md](addresses-api.md) |

Related: a collector's items are [collections-api.md](collections-api.md)
(`GET /collections/user/:userId`). Following is [follows-api.md](follows-api.md).

Code: `packages/users` (`createRouter`, `UserService`, `dto/user.dto.ts`). The
stats come from collections and social, composed in `apps/backend/src/bootstrap.ts`.

---

## Authentication

`/users/me` routes need the Clerk session token
(`Authorization: Bearer <token>`). They return the standard `requireAuth`
errors: 401 `AUTH_UNAUTHENTICATED`, `AUTH_INVALID_TOKEN`,
`AUTH_ACCOUNT_NOT_FOUND`; 403 `AUTH_ACCOUNT_SUSPENDED`, `AUTH_EMAIL_UNVERIFIED`.
See [auth-api.md](auth-api.md) for what each means and how to react.

`GET /users/:id` and `/users/handle/:handle` are public. A valid token is
optional and only fills in `viewer` (do I follow them? is this me?). An invalid
token is treated as a guest.

---

## Shapes

### `Profile`: a collector's profile, as anyone sees it

Returned for **both PUBLIC and PRIVATE** profiles. Being private hides what the
collector **owns**, never who they are (see [Public and private profiles](#public-and-private-profiles)).

```jsonc
{
  "id": "9b1d7e3a-4c2f-4a8b-b6d1-2e3f4a5b6c7d",
  "handle": "mia.figures",
  "fullName": "Mia Lopez",
  "avatarUrl": "https://img.clerk.com/eyJ0eXBlIjoi...",
  "bio": "Vinyl figures and signed posters.",
  "createdAt": "2026-05-02T11:20:13.000Z",
  "isPrivate": true,                 // profileVisibility = PRIVATE → hide the collection tab
  "stats": ProfileStats,             // always shown, private or not
  "viewer": {                        // null for guests
    "isSelf": false,                 // true when you open your own profile
    "isFollowing": true              // drives the Follow / Following button
  }
}
```

### `ProfileStats`

```jsonc
{
  "claimedItems": 12,                // items on their shelf (counted, never listed, when private)
  "artistCollections": 3,            // artist collections they hold items from
  "collectionProgress": { "owned": 10, "total": 25, "percentage": 40 },
  "followers": 7,                    // collectors following them
  "following": 2,                    // collectors they follow
  "followingArtists": 4              // artists they follow
}
```

Deactivated and deleted accounts are left out of `followers` and `following`.

### `PublicUser`: the base fields

```jsonc
{
  "id": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90",  // User.id (uuid)
  "handle": "liam_collects",                      // null if never set
  "fullName": "Liam Carter",                      // null if never set
  "avatarUrl": "https://img.clerk.com/eyJ0eXBlIjoi...", // null if none
  "bio": "Card collector since 2009.",            // null if none
  "createdAt": "2026-07-16T04:41:00.000Z"        // ISO 8601
}
```

### `Me`: what I see about myself

`PublicUser` plus private fields and my `stats` (the same `ProfileStats`):

```jsonc
{
  "id": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90",
  "handle": "liam_collects",
  "fullName": "Liam Carter",
  "avatarUrl": "https://img.clerk.com/eyJ0eXBlIjoi...",
  "bio": null,
  "createdAt": "2026-07-16T04:41:00.000Z",
  "email": "liam.carter@example.com",
  "phone": null,                   // string or null
  "role": "USER",                  // always "USER" today
  "profileVisibility": "PRIVATE",  // "PUBLIC" | "PRIVATE"; new accounts start PRIVATE
  "generalLocation": null,         // coarse, e.g. "Austin, TX"; never shown to others
  "preferredMarketId": null,       // uuid or null; not editable through this API
  "isActive": true,
  "updatedAt": "2026-07-16T04:41:00.000Z",
  "stats": { "claimedItems": 12, "artistCollections": 3, "collectionProgress": { "owned": 10, "total": 25, "percentage": 40 }, "followers": 7, "following": 2, "followingArtists": 4 }
}
```

---

## Endpoints

### `GET /api/v1/users/me`

Required auth. No params.

```json
{
  "data": {
    "id": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90",
    "handle": "liam_collects",
    "fullName": "Liam Carter",
    "avatarUrl": "https://img.clerk.com/eyJ0eXBlIjoi...",
    "bio": null,
    "createdAt": "2026-07-16T04:41:00.000Z",
    "email": "liam.carter@example.com",
    "phone": null,
    "role": "USER",
    "profileVisibility": "PRIVATE",
    "generalLocation": null,
    "preferredMarketId": null,
    "isActive": true,
    "updatedAt": "2026-07-16T04:41:00.000Z",
    "stats": { "claimedItems": 12, "artistCollections": 3, "collectionProgress": { "owned": 10, "total": 25, "percentage": 40 }, "followers": 7, "following": 2, "followingArtists": 4 }
  }
}
```

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_*` | `requireAuth` failed |
| 404 | `USERS_NOT_FOUND` | The user row is archived (soft-deleted) |

### `PATCH /api/v1/users/me`

Required auth. Send only the fields you want to change. Unknown fields are
rejected. An empty body `{}` is allowed and changes nothing except
`updatedAt`.

| Field | Type | Rules |
|---|---|---|
| `handle` | string | 3–50 chars, only letters, digits, `_` and `.`; unique |
| `fullName` | string | 1–200 chars |
| `avatarUrl` | string | A valid URL |
| `bio` | string | At most 500 chars (`""` is allowed) |
| `phone` | string | 5–32 chars, no format check |
| `generalLocation` | string | At most 120 chars. A city or region, never an address |
| `profileVisibility` | string | `PUBLIC` or `PRIVATE`. The profile privacy switch. See [Public and private profiles](#public-and-private-profiles). |

No field accepts `null`. To clear `bio` or `generalLocation`, send `""`.
`email`, `role`, `isActive` and `preferredMarketId` cannot be changed here.

```json
{
  "handle": "liam.collects",
  "bio": "Card collector since 2009.",
  "generalLocation": "Austin, TX",
  "profileVisibility": "PUBLIC"
}
```

Response `200`: the updated `Me`, same shape as `GET /users/me` but **without
`stats`**. Re-read `GET /users/me` if you need them.

**Privacy switch only:**

```json
{ "profileVisibility": "PRIVATE" }
```

The change takes effect immediately everywhere: profile, shelf, NFC taps and the
ledger. Cached Discover and Marketplace lists are not involved, because they never
show owners.

| Status | Code | When |
|---|---|---|
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |
| 401 / 403 | `AUTH_*` | `requireAuth` failed |
| 409 | `USERS_HANDLE_TAKEN` | Another user already has this handle |
| 409 | `USERS_EMAIL_TAKEN` | Email collision (cannot be triggered from this body today) |
| 422 | `VALIDATION_ERROR` | A field broke a rule above, or an unknown field was sent |

### `GET /api/v1/users/:id`

Optional auth. A collector's profile, **public or private**.

| Param | In | Type | Notes |
|---|---|---|---|
| `id` | path | uuid | `User.id`. A malformed id is a 404, like an unknown one. |

```jsonc
{ "data": Profile }
```

Then, to show their items, call `GET /collections/user/:id`. For a private profile,
that returns **403 `COLLECTIONS_PROFILE_PRIVATE`**, so skip it when
`isPrivate` is `true` and show "This profile is private" instead.

| Status | Code | When |
|---|---|---|
| 404 | `USERS_NOT_FOUND` | No such user, or the account is deleted or deactivated |

### `GET /api/v1/users/handle/:handle`

Optional auth. The same `Profile`, looked up by handle, for links like
`hitbox.app/@mia.figures`. The lookup ignores case, and a leading `@` is ignored.

| Param | In | Type | Notes |
|---|---|---|---|
| `handle` | path | string | 1–50 chars |

Errors are the same as `GET /users/:id`.

---

## How it works

### Public and private profiles

Every collector chooses with `PATCH /users/me { "profileVisibility": … }`. New
accounts start **`PRIVATE`**.

| What others see | PUBLIC profile | PRIVATE profile |
|---|---|---|
| Name, handle, avatar, bio, join date | ✅ | ✅ |
| Stats: item count, collections, progress, followers, following | ✅ | ✅ |
| Follow button, followers and following lists | ✅ | ✅ (anyone can follow) |
| Their items (`GET /collections/user/:id`) | ✅ only items they marked `PUBLIC` | ❌ 403 `COLLECTIONS_PROFILE_PRIVATE` |
| Their name when you tap an item they own (NFC verify/claim) | ✅ only for items marked `PUBLIC` | ❌ "another collector" |
| Their name on an item's ownership history (`/ledger`) | ✅ only for items marked `PUBLIC` | ❌ `ownerId: null` |

So there are **two switches**, and an item is shown as theirs only when both are on:
the profile is `PUBLIC`, **and** the item is `PUBLIC` (`PATCH /collections/me/:skuId`).
Making the profile private hides every item at once, without changing any item's
own setting. Switching back restores the previous per-item choices.

The owner always sees everything about themselves: `/users/me`, `/collections/me`,
and `/collections/user/<own id>` all show the full shelf.

What is never shown to others, on any profile: `email`, `phone`, `role`,
`generalLocation`, `preferredMarketId`.

Only a **deleted or deactivated** account returns 404.

### Where profile values come from

The row is created from Clerk on first sign-up (see
[auth-api.md](auth-api.md#first-sign-in-step-by-step)):

| Field | Initial value |
|---|---|
| `handle` | Clerk username |
| `fullName` | Clerk first + last name |
| `avatarUrl` | Clerk profile image |
| `email` | Clerk primary email |
| `profileVisibility` | `PRIVATE` |
| `bio`, `phone`, `generalLocation`, `preferredMarketId` | `null` |

---

## Known limitations

- **Clerk updates overwrite some edits.** Every Clerk `user.updated` webhook
  rewrites `handle`, `fullName`, `avatarUrl` and `email` from Clerk. So a
  `PATCH /users/me` change to `handle`, `fullName` or `avatarUrl` is lost the
  next time the user changes anything in Clerk. To keep them in sync, update
  the same values in Clerk too (username, first/last name, profile image).
- **No avatar upload here.** `avatarUrl` must already be a hosted URL. Upload
  the image through Clerk (`user.setProfileImage`) and use the URL it returns.
- **Profiles can be probed by id.** A private profile now returns 200 with
  its name, instead of 404, so whether an id or handle exists can be checked. This
  is the cost of showing private profiles at all.
- **`fullName` cannot be cleared.** It needs at least 1 char, and `null` is not
  accepted.
