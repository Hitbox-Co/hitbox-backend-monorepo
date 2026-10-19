# Admin Console — Authentication & Authorization

> How a person signs into the admin console, what the backend does with that
> session, and how "who are you" becomes "what may you see".
>
> Companion to [admin-console-api.md](admin-console-api.md) (screen-by-screen
> endpoints) and [admin-api-reference.md](admin-api-reference.md)
> (module-by-module reference).

---

## 1. The one-paragraph version

**Clerk owns identity. This backend owns authorization.** Clerk authenticates
the person and mints a session JWT; the backend verifies that JWT locally,
maps the Clerk user to a local `User` row, and then resolves what that user may
do from its own role/permission tables. Clerk knows nothing about HitBox roles,
and the backend stores no passwords.

Two consequences worth internalising before you write any code:

1. **The frontend never calls a HitBox login endpoint.** Sign-in, sign-up,
   MFA, password reset and session refresh all happen against Clerk's SDK. The
   backend has no `/auth/login`.
2. **A valid Clerk session is not authorization.** It gets you past
   `requireAuth` and nothing more. Every admin route additionally checks a
   capability the user holds through a role assignment — see 5.

---

## 2. Sign-in flow

```text
  Browser (admin console)                Clerk                 HitBox backend
        │                                  │                          │
        │  1. <SignIn /> — email, password,│                          │
        │     MFA, SSO… all handled here   │                          │
        ├─────────────────────────────────▶│                          │
        │                                  │                          │
        │  2. session JWT + __session cookie                          │
        │◀─────────────────────────────────┤                          │
        │                                  │                          │
        │  3. GET /api/v1/authz/me                                    │
        │     Authorization: Bearer <jwt>                             │
        ├────────────────────────────────────────────────────────────▶│
        │                                  │                          │
        │                                  │   4. verifyToken(jwt)    │
        │                                  │      networkless, local  │
        │                                  │◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
        │                                  │      (JWKS, cached)      │
        │                                  │                          │
        │                                  │   5. clerkUserId → local │
        │                                  │      User row (port)     │
        │                                  │                          │
        │                                  │   6. load role grants,   │
        │                                  │      compute permissions │
        │                                  │                          │
        │  7. { userId, permissions[], roles[] }                      │
        │◀────────────────────────────────────────────────────────────┤
        │                                                             │
        │  8. render the sidebar from `permissions`                   │
```

### Step 3 — how to send the token

Two accepted forms, checked in this order:

| Form | Header / cookie | When |
|---|---|---|
| Bearer token | `Authorization: Bearer <jwt>` | **Preferred.** Explicit, works cross-origin |
| Session cookie | `__session` | Automatic when the console is served from a Clerk-configured domain |

With Clerk's React SDK:

```ts
import { useAuth } from '@clerk/clerk-react';

const { getToken } = useAuth();

async function apiFetch(path: string, init: RequestInit = {}) {
  const token = await getToken();          // refreshes automatically when near expiry
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}
```

**Call `getToken()` per request, not once at startup.** Clerk session tokens
are short-lived (~60s by default) and the SDK refreshes them transparently. A
token captured into a module-level variable will start returning
`401 AUTH_INVALID_TOKEN` within a minute.

### Step 4 — verification is local

`verifyToken` from `@clerk/backend` validates the JWT signature against Clerk's
JWKS, which is fetched once and cached. **No network call happens per request.**
That matters for latency budgeting: authentication adds microseconds, not a
round trip.

If `CLERK_AUTHORIZED_PARTIES` is configured, the token's `azp` claim is checked
against that comma-separated origin list — this is what stops a token minted
for a different frontend from being replayed against this API.

---

## 3. What the backend checks, in order

`requireAuth` runs before every protected route
([require-auth.middleware.ts](../../packages/auth/src/middleware/require-auth.middleware.ts)).
Each step has its own error code, so the console can react precisely:

| # | Check | Failure | Status | Code |
|---|---|---|---|---|
| 1 | Token present (header or cookie) | none supplied | 401 | `AUTH_UNAUTHENTICATED` |
| 2 | JWT signature + expiry + `azp` | invalid or expired | 401 | `AUTH_INVALID_TOKEN` |
| 3 | Local `User` exists for `sub` | never synced, or deleted | 401 | `AUTH_ACCOUNT_NOT_FOUND` |
| 4 | Account not suspended | suspended | 403 | `AUTH_ACCOUNT_SUSPENDED` |
| 5 | Email verified | unverified | 403 | `AUTH_EMAIL_UNVERIFIED` |

On success the request carries:

```ts
req.auth = {
  accountId: string,       // the LOCAL User.id — this is what everything else uses
  clerkUserId: string,     // Clerk's `sub`
  email: string,
  role: UserRole,
  sessionId: string | null,
}
```

> **`accountId` is the local id, not the Clerk id.** Every foreign key in this
> database points at `User.id`. If you ever need to correlate with Clerk's
> dashboard, that is `clerkUserId`.

### How the console should react

| Code | UI behaviour |
|---|---|
| `AUTH_UNAUTHENTICATED` | Redirect to Clerk sign-in |
| `AUTH_INVALID_TOKEN` | Call `getToken({ skipCache: true })` and retry **once**; if it fails again, sign out |
| `AUTH_ACCOUNT_NOT_FOUND` | Show "your account is still being provisioned" — the webhook has not landed yet (4). Do **not** loop |
| `AUTH_ACCOUNT_SUSPENDED` | Terminal. Show a support contact, sign out |
| `AUTH_EMAIL_UNVERIFIED` | Send them back to Clerk's verification flow |

Step 5 is defence-in-depth: Clerk only mints a session after email
verification, so this should be unreachable. It fires if the local projection
has drifted — treat it as a bug signal, not a normal state.

---

## 4. How a Clerk user becomes a local user

The backend keeps a **local projection** of every Clerk user in the `users`
table, so the rest of the system can use plain foreign keys instead of calling
Clerk on every join.

```text
 Clerk                    auth module                        users module
   │                          │                                   │
   │ POST /api/v1/auth/       │                                   │
   │  webhooks/clerk          │                                   │
   ├─────────────────────────▶│ 1. verify svix signature          │
   │                          │    (needs the RAW request bytes)  │
   │                          │ 2. idempotency check — a stored   │
   │                          │    svix-id means already handled  │
   │                          │ 3. translate the Clerk payload,   │
   │                          │    publish a domain event ───────▶│
   │                          │                                   │ upsert /
   │◀── 200 {received:true} ──┤                                   │ soft-delete
```

| Clerk event | Domain event | Effect |
|---|---|---|
| `user.created` | `auth.user.registered` | Upsert a `User` row |
| `user.updated` | `auth.user.updated` | Upsert |
| `user.deleted` | `auth.user.deleted` | Soft delete |

Everything else Clerk sends is ignored.

**Nothing outside the auth module ever sees a Clerk payload shape.** The domain
events are the contract, which is what keeps Clerk swappable.

### The provisioning race

A user who signs up and immediately hits the API can arrive **before** the
webhook does. That is `401 AUTH_ACCOUNT_NOT_FOUND` at step 3 — the session is
valid, the local row does not exist yet.

Handle it with a short, bounded retry and a human message, never a tight loop.
In practice it resolves in well under a second; if it persists, the webhook
endpoint is misconfigured.

### Local development

Clerk cannot reach `localhost`. Tunnel it:

```bash
ngrok http 8000
# then point the Clerk dashboard webhook at
# https://<your-tunnel>.ngrok-free.dev/api/v1/auth/webhooks/clerk
```

ngrok-free clients must send `ngrok-skip-browser-warning: true`, or the first
request returns ngrok's HTML interstitial instead of JSON.

---

## 5. Authentication ≠ authorization

A valid session tells you **who**. It says nothing about **what**.

```text
requireAuth              →  "this is user u-77213f, and they are not suspended"
requirePermission(cap)   →  "…and they hold `order:read` at a scope covering this record"
```

Authorization is resolved from the local tables only. Clerk has no concept of
HitBox roles, and **no role information travels in the JWT**. Do not put roles
in Clerk metadata and read them client-side — they will not match what the
server enforces.

### The model

```text
User ──< RoleAssignment >── Role ──< RolePermission >── Permission
              │
         scopeType: GLOBAL | ORGANIZATION
         scopeId:   null   | organizationId
```

- A person may hold **several roles at once** — `ARTIST` plus `BRAND_EMPLOYEE`
  at brand A plus `HITBOX_FULL_STACK_ENGINEER` is a normal state. Their
  effective permissions are the **union**. Nothing merges roles.
- A permission key is `resource:action:scope`, e.g. `order:read:global`,
  `payment-royalty:manage:organization`.
- Revoking is a **soft delete** — the assignment row survives with `revokedAt`
  set, so an audit can still answer "who held what in March". Revoked
  assignments confer nothing.
- Deactivating a role (`isActive: false`) kills it everywhere at once.

### `GET /api/v1/authz/me`

Call once after sign-in. This is the only thing the console should use to
decide what to render.

```json
{
  "data": {
    "userId": "3f2a9b1c-…",
    "permissions": [
      "audit-log:read:global",
      "buyer-profile:manage:global",
      "drop:manage:global",
      "order:manage:global",
      "payment-royalty:manage:global"
    ],
    "roles": [
      { "roleId": "r-1…", "roleName": "HITBOX_SYSTEM_ADMIN", "organizationId": null }
    ]
  }
}
```

**Drive the UI from `permissions`, never from `roles`.**

```ts
// Correct — survives a role being renamed, split, or newly defined by an operator
const canSeeFinance = permissions.some(p => p.startsWith('payment-royalty:'));

// Wrong — breaks the moment someone defines REGIONAL_FINANCE_LEAD
const canSeeFinance = roles.some(r => r.roleName === 'HITBOX_FINANCE_ADMIN');
```

Roles are operator-editable data, not constants. The Roles screen exists
precisely so new ones can be created; a console that hardcodes role names is
broken by design the first time someone uses that screen.

`organizationId` is non-null for brand-scoped roles. A user can hold the same
role at several organizations, and will appear once per scope.

### Caching

Grants are cached in-process with a short TTL and invalidated across instances
when an assignment changes. You do not need to do anything about this — but it
means a freshly granted role can take a few seconds to appear in
`/authz/me`. After assigning a role in the Team screen, wait a moment before
asserting the change, or refetch.

---

## 6. Scope: the part that is easy to get wrong

Holding a capability is not the same as holding it *everywhere*.

| Scope | Means |
|---|---|
| `:global` | Every record on the platform |
| `:organization` | Only records belonging to the organizations the assignment names |

The server enforces this on every request; the console does not need to filter.
But two behaviours follow from it that you **do** need to handle:

**1. Out-of-scope records return `404`, not `403`.** A distinct `403` would
confirm the record exists, which is enough to enumerate another organization's
data by id. So "not found" and "not yours" are deliberately indistinguishable.
Do not write UI copy that promises the record exists.

**2. An explicit `organizationId` filter outside your reach is `403
SCOPE_MISMATCH`.** Passing a filter is narrowing *within* your scope, never
widening it. If the console offers an organization picker, populate it from the
caller's own `roles[].organizationId` values.

Field-level filtering follows the same rule. On `GET /admin/dashboard/orders`,
a caller without `payment-royalty:read` gets items with **no `amount` key at
all** — not `null`, not `0`. Build the table so a column can be absent.

---

## 7. Sign-out

```ts
import { useClerk } from '@clerk/clerk-react';
const { signOut } = useClerk();
await signOut();
```

Clerk revokes the session. There is nothing to call on the backend — it holds
no session state, only the verification key. The next request without a valid
token is a plain `401`.

---

## 8. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` | **yes** | Backend key (`sk_…`); verifies JWTs |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **yes** | svix signing secret (`whsec_…`) for the webhook endpoint |
| `CLERK_AUTHORIZED_PARTIES` | no | Comma-separated origins checked against the token's `azp` claim |

`createAuthModule` throws a specific error at boot if either required value is
missing, rather than failing per-request later.

The webhook handler needs the **raw request bytes** for signature verification.
`app.ts` captures them via `express.json({ verify })` into `req.rawBody` — do
not add body-parsing middleware ahead of it.

Frontend needs only the publishable key (`pk_…`), which is safe to ship.

---

## 9. Checklist

- [ ] Use Clerk's SDK for sign-in/up — there is no backend login endpoint
- [ ] Call `getToken()` **per request**; never cache the JWT
- [ ] Send `Authorization: Bearer <jwt>`
- [ ] Call `/authz/me` once after sign-in and cache the result for the session
- [ ] Build navigation from `permissions`, never from `roles[].roleName`
- [ ] Match on the `resource:action` prefix unless you specifically care about scope
- [ ] Retry **once** on `AUTH_INVALID_TOKEN` with `skipCache: true`, then sign out
- [ ] Show a provisioning message on `AUTH_ACCOUNT_NOT_FOUND`; do not loop
- [ ] Treat `404` as "not found or not yours" — never promise existence
- [ ] Expect fields (not just records) to be missing based on permissions
- [ ] Refetch after assigning a role; grants are cached briefly
