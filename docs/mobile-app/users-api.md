# Users — API

The signed-in user's own profile (Profile tab, Edit profile screen) and other
users' public profiles (for example a collector's page).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/users/me` | required | My full profile |
| `PATCH` | `/api/v1/users/me` | required | Edit my profile |
| `GET` | `/api/v1/users/:id` | public | Another user's public profile |

Code: `packages/users` (`createRouter`, `UserService`, `dto/user.dto.ts`).

---

## Authentication

`/users/me` routes need the Clerk session token
(`Authorization: Bearer <token>`). They return the standard `requireAuth`
errors: 401 `AUTH_UNAUTHENTICATED`, `AUTH_INVALID_TOKEN`,
`AUTH_ACCOUNT_NOT_FOUND`; 403 `AUTH_ACCOUNT_SUSPENDED`, `AUTH_EMAIL_UNVERIFIED`.
See [auth-api.md](auth-api.md) for what each means and how to react.

`GET /users/:id` is public and ignores any token.

---

## Shapes

### `PublicUser`: what anyone may see

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

`PublicUser` plus private fields:

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
  "updatedAt": "2026-07-16T04:41:00.000Z"
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
    "updatedAt": "2026-07-16T04:41:00.000Z"
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
| `profileVisibility` | string | `PUBLIC` or `PRIVATE` |

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

Response `200`: the updated `Me`, same shape as `GET /users/me`.

| Status | Code | When |
|---|---|---|
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |
| 401 / 403 | `AUTH_*` | `requireAuth` failed |
| 409 | `USERS_HANDLE_TAKEN` | Another user already has this handle |
| 409 | `USERS_EMAIL_TAKEN` | Email collision (cannot be triggered from this body today) |
| 422 | `VALIDATION_ERROR` | A field broke a rule above, or an unknown field was sent |

### `GET /api/v1/users/:id`

Public. Another user's profile.

| Param | In | Type | Notes |
|---|---|---|---|
| `id` | path | uuid | `User.id` |

```json
{
  "data": {
    "id": "9b1d7e3a-4c2f-4a8b-b6d1-2e3f4a5b6c7d",
    "handle": "mia.figures",
    "fullName": "Mia Lopez",
    "avatarUrl": "https://img.clerk.com/eyJ0eXBlIjoi...",
    "bio": "Vinyl figures and signed posters.",
    "createdAt": "2026-05-02T11:20:13.000Z"
  }
}
```

| Status | Code | When |
|---|---|---|
| 404 | `USERS_NOT_FOUND` | No such user, the user is archived, **or the profile is `PRIVATE`** |
| 500 | `INTERNAL_ERROR` | `id` is not a valid uuid (see Known limitations) |

---

## How it works

### Who can see a profile

`GET /users/:id` returns a profile only when **both** are true:

1. The user row exists and `archivedAt` is `null` (not soft-deleted).
2. `profileVisibility` is `PUBLIC`.

Otherwise it returns 404 `USERS_NOT_FOUND`. A private profile looks exactly
like a missing one, on purpose, so ids cannot be probed.

New accounts start as **`PRIVATE`**. A user has no public profile until they
set `profileVisibility: "PUBLIC"` with `PATCH /users/me`. If the app shows
other users' profiles, add a visibility toggle to Edit profile.

`email`, `phone`, `role`, `generalLocation` and `preferredMarketId` are never
in the public shape.

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
- **A non-uuid `id` returns 500, not 404.** `GET /users/:id` does not validate
  the id format, and the database rejects it. Only call it with ids the API
  gave you.
- **`fullName` cannot be cleared.** It needs at least 1 char, and `null` is not
  accepted.
