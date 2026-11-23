# Auth — API

Everything the mobile app needs for sign-up, sign-in, signed requests,
sign-out and account-state errors. Clerk does the authentication; this backend
verifies Clerk's session token and keeps a local user row in sync. It also
covers the health check the app can use as a connectivity probe.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | public | Is the API up? |
| `POST` | `/api/v1/auth/registration/validate` | public | Check sign-up fields before calling Clerk |
| `GET` | `/api/v1/auth/me` | required | The signed-in account (id, email, role) |
| `GET` | `/api/v1/authz/me` | required | The signed-in user's roles and permission keys |
| `POST` | `/api/v1/auth/webhooks/clerk` | Clerk signature | Clerk → backend webhook. **Server-to-server; the app never calls it.** |

Code: `packages/auth` (router, `requireAuth`, `createOptionalAuth`, webhook
service), `packages/users` (the local user row), `packages/access-control`
(`createSelfRouter`), `apps/backend/src/routes.ts` (`/health`).

---

## Authentication

### Who does what

| Task | Clerk (mobile SDK, e.g. `@clerk/clerk-expo`) | This backend |
|---|---|---|
| Sign-up (email + password) | Yes | Only a pre-check: `POST /auth/registration/validate` |
| Email verification code (OTP) | Yes | No |
| Sign-in (password, email code, social / OAuth) | Yes | No |
| Password reset / forgot password | Yes | No |
| Session token issue and refresh | Yes (`getToken()`) | No |
| Sign-out | Yes (`signOut()`) | No |
| Verify the session token on each request | No | Yes (`requireAuth`) |
| Store the user's profile (handle, bio, visibility, …) | Partly (username, name, image) | Yes, the local `User` row (see [users-api.md](users-api.md)) |
| Roles and permissions | No | Yes (`GET /authz/me`) |

**The backend has no login, logout, refresh or password endpoints.** It never
receives or stores a password. It is stateless per request: every request
carries a Clerk session token, and the backend verifies it.

### Sending the token

Send the Clerk **session JWT** on every request that needs a user:

```http
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Imluc18y...
```

On mobile, always use the header. The middleware also looks for Clerk's
`__session` cookie, but the server does not install a cookie parser, so
`req.cookies` is never filled and the cookie is **not** read today (see Known
limitations).

Clerk session tokens are short-lived (about 60 seconds by default). Call
`await getToken()` **right before each request**. The SDK returns a cached
token while it is still valid and refreshes it when needed. Do not store the
token yourself.

### What `requireAuth` checks

Routes marked **required** run `requireAuth`. It runs these checks in order and
stops at the first failure:

| # | Check | Fails with |
|---|---|---|
| 1 | A `Bearer` token is present in the `Authorization` header | 401 `AUTH_UNAUTHENTICATED` |
| 2 | Clerk verifies the JWT: signature, expiry, and `azp` if `CLERK_AUTHORIZED_PARTIES` is set | 401 `AUTH_INVALID_TOKEN` |
| 3 | A local user row exists for the token's Clerk user id. If not, the backend tries to create it from Clerk (see [Sign-up](#a-sign-up)) | 401 `AUTH_ACCOUNT_NOT_FOUND` |
| 4 | The row is not deleted (`archivedAt` is null) | 401 `AUTH_ACCOUNT_NOT_FOUND` |
| 5 | The row is not suspended (`isActive` is true) | 403 `AUTH_ACCOUNT_SUSPENDED` |
| 6 | The primary email is verified | 403 `AUTH_EMAIL_UNVERIFIED` |

On success, the request carries the [`AuthContext`](#authcontext-the-signed-in-account).

### Optional auth

A few public routes personalise the response when a token is sent. They use
`createOptionalAuth`. Today **only the Discover routes** use it
(`GET /discover`, `/discover/products`, `/discover/creators`), for the
wishlist heart. See [discover-api.md](discover-api.md). Every other public
route, such as `GET /products` or `GET /marketplace`, ignores the token.

How optional auth behaves:

- No token: served as a guest.
- A token that `requireAuth` would reject with 401 or 403 (expired, invalid,
  unknown account, deleted, suspended): also served as a guest. **Never a 401.**
- Any other failure (for example a 5xx while looking up the account) is still
  returned as an error.

So on Discover, a stale token silently gives guest data (`isWishlisted: null`).
If the user is signed in and you see `null`, refresh the token.

### Config the mobile dev needs

| Setting | Where | Notes |
|---|---|---|
| Clerk **publishable key** (`pk_test_…` / `pk_live_…`) | The app | Passed to `ClerkProvider`. Safe to ship in the app. |
| API base URL | The app | e.g. `https://api.example.com/api/v1` |
| `CLERK_SECRET_KEY` (`sk_…`) | Server only | Verifies tokens and reads Clerk users. **Never put it in the app.** |
| `CLERK_WEBHOOK_SIGNING_SECRET` (`whsec_…`) | Server only | Verifies the Clerk webhook. |
| `CLERK_AUTHORIZED_PARTIES` | Server only, optional | Comma-separated list of allowed origins, e.g. `https://app.example.com,http://localhost:8081`. When set, a token whose `azp` (origin) claim is not in the list fails with 401 `AUTH_INVALID_TOKEN`. If a client gets that error with a token that works elsewhere, check that its origin is in this list. |

The app and the server must use the **same Clerk instance** (development or
production). A token from a development instance fails on a production server
with `AUTH_INVALID_TOKEN`.

---

## Flows

### (a) Sign-up

1. **Pre-check (backend).** Call `POST /auth/registration/validate` with the
   form fields. It checks the email format, the username format and length,
   the name lengths, and whether the **email** is already registered. It does
   not check whether the username is taken.
   - 200 → continue.
   - 409 `AUTH_EMAIL_TAKEN` → "An account with this email already exists. Sign in instead?"
   - 422 `VALIDATION_ERROR` → show `details[].message` under each field (`path` is the field name).
2. **Sign up (Clerk).** `signUp.create({ emailAddress, password, username, firstName, lastName })`.
   Clerk enforces the password policy.
3. **Verify email (Clerk).** `signUp.prepareEmailAddressVerification({ strategy: 'email_code' })`,
   then `signUp.attemptEmailAddressVerification({ code })`. Clerk issues a
   session only after this succeeds. Then `setActive({ session })`.
4. **Local account (backend, automatic).** Clerk sends a `user.created`
   webhook to the backend. The backend creates the local `User` row (see
   [Webhook events](#clerk-webhook-events)). The app does nothing here.
5. **Fallback if the webhook is late.** On the first **required** call, if
   there is still no local row, `requireAuth` fetches the user from Clerk
   and creates the same row itself, then continues normally. This runs only
   after the token is verified, only when the Clerk user has a **verified**
   primary email, and never for a deleted row. If it fails (Clerk
   unreachable, no verified email), that request gets 401
   `AUTH_ACCOUNT_NOT_FOUND` and the backend does not ask Clerk again for that
   user for **10 seconds**. Parallel requests for the same new user share one
   attempt.
6. **Load the account.** Call `GET /users/me` (full profile) or
   `GET /auth/me`. If it returns 401 `AUTH_ACCOUNT_NOT_FOUND` right after
   sign-up, wait a few seconds and retry (2–3 times, at least 10 s apart).

Social sign-up (Google, Apple) works the same from step 4: Clerk creates the
user, sends `user.created`, and the backend creates the row.

### (b) Sign-in

1. **Sign in (Clerk).** `signIn.create(...)` with password, email code or an
   OAuth strategy, then `setActive({ session })`.
2. **Load the account (backend).** `GET /users/me` for the profile screen, or
   `GET /auth/me` for just the ids. A 200 confirms the backend accepts the
   session and the local row exists.
3. Optionally `GET /authz/me` if the app shows or hides features by permission.

### (c) Every request

```ts
const token = await getToken();
let res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
if (res.status === 401 && (await res.clone().json()).error?.code === 'AUTH_INVALID_TOKEN') {
  const fresh = await getToken({ skipCache: true });
  res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${fresh}` } });
}
```

- Get a fresh token per request.
- On `AUTH_INVALID_TOKEN`, refresh once with `skipCache: true` and retry once.
  If it fails again, sign out and show sign-in.
- Do not retry on 403s. They are about the account, not the token.

### (d) Sign-out

Call Clerk's `signOut()` and clear local app state. There is no backend call.
The backend keeps no session, so nothing needs to be revoked there. Once the
Clerk session ends, its tokens stop verifying.

Password reset is also Clerk only (`signIn.create({ strategy: 'reset_password_email_code', identifier })`
and so on). No backend call.

### (e) Account-state errors

| Status | Code | Cause | What the app should show / do |
|---|---|---|---|
| 401 | `AUTH_UNAUTHENTICATED` | No token sent | Go to sign-in. If the user looks signed in, it is a client bug: the header is missing. |
| 401 | `AUTH_INVALID_TOKEN` | Token expired, bad signature, wrong Clerk instance, or origin not in `CLERK_AUTHORIZED_PARTIES` | Refresh the token and retry once. Then sign out → sign-in. |
| 401 | `AUTH_ACCOUNT_NOT_FOUND` | No local row yet (just signed up), or the account was deleted | Just signed up: "Setting up your account…" and retry after ~10 s. Otherwise: "This account no longer exists", then `signOut()`. |
| 403 | `AUTH_ACCOUNT_SUSPENDED` | Local row has `isActive = false` | "Your account is suspended. Contact support." Do not retry. Offer sign-out. |
| 403 | `AUTH_EMAIL_UNVERIFIED` | Primary email not verified | Send the user to Clerk's email verification step. (Not raised today; see Known limitations.) |

---

## Conventions

These apply to every file in this folder.

### Response envelope

```jsonc
// success
{ "data": … }                                   // one resource
{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }  // a page

// error, always this shape
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": … } }
```

`GET /api/v1/health` is the one exception: it has no `data` wrapper.

### Shared error codes

| Status | Code | When |
|---|---|---|
| 400 | `BODY_REQUIRED` | A route needs a JSON body, but none was parsed (missing `Content-Type: application/json`) |
| 404 | `NOT_FOUND` | Unknown route |
| 422 | `VALIDATION_ERROR` | A query param or body field failed validation |
| 429 | `RATE_LIMITED` | Too many requests from this IP |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

A `VALIDATION_ERROR` lists every bad field:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "path": "email", "message": "Enter a valid email address", "code": "invalid_string", "receivedType": "string", "received": "liam@" }
    ]
  }
}
```

`receivedType` and `received` (a preview, at most 60 chars) are filled for
body fields only, not for query params.

### Rate limit

Every `/api/v1/*` route, `/health` included, is limited **per client IP**. The
default is **100 requests per 60 seconds** (`RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW_MS`). Responses carry `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` (seconds) headers. Request 101 in a
window gets 429 `RATE_LIMITED`.

---

## Shapes

### `AuthContext`: the signed-in account

Returned by `GET /auth/me`. It is the same object the backend attaches to
every authenticated request.

```jsonc
{
  "accountId": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90", // User.id (uuid); use this as "my user id"
  "clerkUserId": "user_2pQx7LmN4kR8sT1vW3yZ5aB6cD",     // Clerk's id for the user (token "sub")
  "email": "liam.carter@example.com",                    // from the local row
  "role": "USER",                                         // always "USER" today
  "sessionId": "sess_2pQx9AbC1dE2fG3hI4jK5lM6nO"         // Clerk session id (token "sid"); null if absent
}
```

### `PrincipalGrants`: roles and permissions

Returned by `GET /authz/me`.

```jsonc
{
  "userId": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90", // same as accountId
  "permissions": [                    // sorted, de-duplicated; "resource:action:scope"
    "address:manage:own",
    "drop:read:public",
    "order:create:own"
  ],
  "roles": [                          // one entry per (role, organization) pair
    {
      "roleId": "8d2e4f60-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
      "roleName": "BUYER_COLLECTOR",
      "organizationId": null          // set only for organization-scoped staff roles
    }
  ]
}
```

---

## Endpoints

### `GET /api/v1/health`

Public. No params. Use it to check that the API is reachable.

```json
{ "status": "ok", "uptime": 138.98 }
```

`uptime` is the server process uptime in seconds. There is also `GET /`
(outside `/api/v1`), which returns `{ "success": true, "message": "HitBox Backend is running 🚀" }`
and is not rate limited.

Errors: 429 `RATE_LIMITED` only.

### `POST /api/v1/auth/registration/validate`

Public. Call it on the sign-up form **before** Clerk's sign-up. It checks the
fields with the same rules the API uses and tells you if the email is already
registered. It **creates nothing**.

Request body (JSON, unknown fields are rejected):

| Field | Type | Required | Rules |
|---|---|---|---|
| `email` | string | yes | Trimmed and lowercased, then 1–255 chars and a valid email |
| `username` | string | no | Trimmed, 3–50 chars, only letters, digits, `_` and `.` |
| `firstName` | string | no | Trimmed, at most 100 chars |
| `lastName` | string | no | Trimmed, at most 100 chars |

```json
{
  "email": "Liam.Carter@Example.com ",
  "username": "liam_collects",
  "firstName": "Liam",
  "lastName": "Carter"
}
```

Response `200`:

```json
{ "data": { "valid": true, "email": "liam.carter@example.com" } }
```

`email` comes back normalised (trimmed, lowercased). Use that value for the
Clerk sign-up.

| Status | Code | When |
|---|---|---|
| 400 | `BODY_REQUIRED` | No JSON body (missing `Content-Type: application/json`) |
| 409 | `AUTH_EMAIL_TAKEN` | A local account with this email already exists (deleted accounts included) |
| 422 | `VALIDATION_ERROR` | Bad email, illegal username, a name over 100 chars, or an unknown field |

Not checked here: password strength (Clerk does it) and **username
availability**. A taken username is rejected by Clerk at sign-up if usernames
are unique in your Clerk instance; a taken `handle` shows up later as 409
`USERS_HANDLE_TAKEN` on `PATCH /users/me` (see [users-api.md](users-api.md)).

### `GET /api/v1/auth/me`

Required auth. No params. Returns the signed-in account.

```json
{
  "data": {
    "accountId": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90",
    "clerkUserId": "user_2pQx7LmN4kR8sT1vW3yZ5aB6cD",
    "email": "liam.carter@example.com",
    "role": "USER",
    "sessionId": "sess_2pQx9AbC1dE2fG3hI4jK5lM6nO"
  }
}
```

Errors: the `requireAuth` errors (401 `AUTH_UNAUTHENTICATED`,
`AUTH_INVALID_TOKEN`, `AUTH_ACCOUNT_NOT_FOUND`; 403 `AUTH_ACCOUNT_SUSPENDED`,
`AUTH_EMAIL_UNVERIFIED`).

Use it after sign-in to confirm the backend accepts the session. For the full
profile (handle, name, avatar, visibility), use `GET /users/me` in
[users-api.md](users-api.md).

### `GET /api/v1/authz/me`

Required auth. No params. Returns the caller's roles and effective permission
keys.

When the app would use it: to show or hide features by permission (for
example, hide "Claim" if `nfc-tag-claim:claim:own` is missing), or to detect a
staff account. It is never needed to call buyer routes; the server checks
permissions itself.

```json
{
  "data": {
    "userId": "3f6a2c1e-8b4d-4e7a-9c2f-1d5e6b7a8c90",
    "permissions": [
      "address:manage:own",
      "collectible-instance:read:public",
      "content-unlock:read:own",
      "drop:read:public",
      "my-collections:manage:own",
      "my-collections:read:own",
      "nfc-tag-claim:claim:own",
      "notification-config:update:own",
      "order:create:own",
      "order:read:own",
      "search-discover:read:public",
      "self-profile:read:own",
      "self-profile:update:own"
    ],
    "roles": [
      { "roleId": "8d2e4f60-1a3b-4c5d-9e7f-0a1b2c3d4e5f", "roleName": "BUYER_COLLECTOR", "organizationId": null }
    ]
  }
}
```

The example is the full `BUYER_COLLECTOR` role.

| Status | Code | When |
|---|---|---|
| 401 / 403 | `AUTH_*` | `requireAuth` failed (see above) |
| 401 | `AUTHZ_NO_PRINCIPAL` | Auth ran but no account id was attached (should not happen in practice) |

### `POST /api/v1/auth/webhooks/clerk`

Server-to-server only. Clerk calls it, signed with svix headers (`svix-id`,
`svix-timestamp`, `svix-signature`). It returns `200 { "received": true }`, or
401 `AUTH_WEBHOOK_INVALID_SIGNATURE` for a missing or bad signature. The app
never calls it. What it does is below.

---

## How it works

### Clerk webhook events

The backend handles three Clerk event types. Every other event type is
acknowledged and ignored. Each delivery is processed once: a repeated
`svix-id` is a no-op (ids are kept for 30 days).

| Clerk event | Effect on the local `User` row |
|---|---|
| `user.created` | Creates the row, or links an existing row with the same email. New rows get `role = USER`, `profileVisibility = PRIVATE`, `isActive = true`, and `bio`, `phone`, `generalLocation`, `preferredMarketId` = `null`. |
| `user.updated` | Overwrites `email`, `handle`, `fullName` and `avatarUrl` from Clerk. Also sets `isActive = true` and clears `archivedAt` (reinstates the account). |
| `user.deleted` | Soft-deletes: sets `archivedAt`, `isActive = false`. Every required route then returns 401 `AUTH_ACCOUNT_NOT_FOUND`. The row is kept. |

Field mapping for `user.created` and `user.updated`:

| Clerk | Local `User` |
|---|---|
| primary email | `email` |
| `username` | `handle` |
| `first_name` + `last_name` | `fullName` |
| `image_url` | `avatarUrl` |

A `user.created` / `user.updated` event whose user has **no email** is
skipped (no row is created or changed).

A row is matched by Clerk user id **or** email. So if a row with the same
email already exists (for example from the demo seed), the new Clerk user is
linked to it instead of failing.

### How account state is derived

The local row has no "status" column. `requireAuth` derives it:

| Row | State | Error |
|---|---|---|
| `archivedAt` is set | deleted | 401 `AUTH_ACCOUNT_NOT_FOUND` |
| `archivedAt` is null, `isActive = false` | suspended | 403 `AUTH_ACCOUNT_SUSPENDED` |
| `archivedAt` is null, `isActive = true` | active | none |

### Permission keys

A key reads `resource:action:scope`. `scope` is `own` (only the caller's
records), `public` (public data), `organization` or `global` (staff). The
buyer role, `BUYER_COLLECTOR`, holds only `own` and `public` keys. Treat the
list as a UI hint. The server checks permissions again on every protected
route.

---

## Known limitations

- **No role is assigned at sign-up.** Nothing in the sign-up path gives a new
  user `BUYER_COLLECTOR`; today only the demo seed does. A brand-new user's
  `GET /authz/me` returns `"permissions": []` and `"roles": []`. Routes that
  only need `requireAuth` (auth, users) still work. Do not hide core buyer
  features just because the list is empty.
- **`AUTH_EMAIL_UNVERIFIED` is never raised today.** The account lookup in
  `packages/users` always reports the email as verified. In practice Clerk
  already refuses to issue a session before the email is verified, so this is
  defense-in-depth that is currently switched off. Keep handling the code.
- **A Clerk `user.updated` event lifts a suspension.** It sets `isActive = true`
  and clears `archivedAt`. So a suspended or deleted user who still exists in
  Clerk is reinstated by any change to their Clerk profile.
- **Clerk overwrites profile edits.** `user.updated` rewrites `handle`,
  `fullName` and `avatarUrl`, so changes made only through `PATCH /users/me`
  are lost on the next Clerk update. Update the same values in Clerk too. See
  [users-api.md](users-api.md#known-limitations).
- **No username availability check before sign-up.** Only the email is checked.
- **The `__session` cookie is ignored.** `extractToken` reads `req.cookies.__session`,
  but no cookie-parser middleware is mounted in `apps/backend/src/app.ts`, so
  only the `Authorization: Bearer` header works.
- **`role` in `/auth/me` is always `"USER"`.** It is a legacy field. Staff
  roles live in `/authz/me`.
