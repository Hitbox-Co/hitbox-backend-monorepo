# 05 — Clerk integration

## One instance for the whole platform

```text
                    ┌─────────────────────┐
                    │   ONE Clerk instance│
                    └──────────┬──────────┘
        ┌──────────────┬───────┴───────┬──────────────┐
   hitbox.com    admin.hitbox.com  productmanager…  mobile app
        └──────────────┴───────┬───────┴──────────────┘
                               ▼
                        api.hitbox.com
```

Every person has exactly one Clerk identity, whatever they do on the platform.
Customers, artists, product managers, finance managers and platform
administrators all sign in through the same instance.

### Why not a separate instance for admins

Because **admin is an authorization concept, not an identity one**. A second
instance would buy nothing and cost a lot:

| Separate admin instance | One instance |
|---|---|
| Two identity systems to secure, patch, monitor | One |
| Two MFA policies that drift apart | One policy, enforced once |
| A staff member who is also a customer needs two accounts | One account, two roles |
| "Which instance is this token from?" on every request | One verification path |
| Promoting someone to admin means creating a new identity | Grant a role |

An employee who buys a collectible is the same person. Modelling that as two
identities creates a reconciliation problem that never ends.

## What Clerk owns

Sign-up, sign-in, email and phone verification, passwords, OAuth/social login,
MFA, session lifecycle, account recovery, identity profile.

## What Clerk does *not* own

Roles. Permissions. Organization membership for authorization. Resource
ownership. Business policy.

### Clerk metadata is not our permission database

Do not put the permission model in `publicMetadata` / `privateMetadata`.

- **It cannot be joined.** "Does this product belong to the caller's
  organization?" is a SQL question. Metadata cannot answer it.
- **It has no referential integrity.** Renaming a permission means rewriting N
  user records with no transaction and no rollback.
- **It is not auditable.** There is no `granted_by`, no `granted_at`, no history.
- **It does not scale.** A multi-role, multi-tenant user's effective permission
  set is hundreds of entries. Metadata has size limits, and anything that lands
  in a session token bloats every request.
- **It goes stale.** Metadata that reaches the client through a JWT stays valid
  until the token expires. Revocation must be immediate.

What metadata *is* reasonable for: lightweight, non-authoritative hints —
onboarding state, UI preferences, a display flag. Never something a decision
depends on.

Clerk Organizations are similarly optional. `Organization.clerkOrgId` exists so
Clerk's invitation UX can be adopted later, but **authorization never reads it**
— our `organizations` and `organization_memberships` rows are the truth.

## The link: `clerkUserId`

```prisma
model User {
  id          String @id @default(cuid())
  clerkUserId String @unique @map("clerk_user_id")   // ← the only link
  email       String @unique
  // ...
}
```

Everything authorization-related hangs off `User.id`, never off `clerkUserId`.
So if the identity provider is ever replaced, one column changes.

## Provisioning flow

```text
User signs up on any frontend
        │
        ▼
   Clerk creates the identity
        │
        │  webhook  user.created  (svix-signed)
        ▼
POST /api/v1/auth/webhooks/clerk
        │
        ├─ verify svix signature over the RAW body
        ├─ idempotency: is this svix-id already in auth_webhook_events?
        ▼
   publish  auth.user.registered
        │
        ▼
   users module: upsert the local User row  (idempotent)
        │
        │  publish  users.user.provisioned   ← the LOCAL row now exists
        ▼
   authz: ensureDefaultRole(userId)  →  grants USER
```

The two-event chain is not incidental. The in-process bus fires subscribers
concurrently with **no ordering guarantee**, so authz cannot subscribe to
`auth.user.registered` — the role insert would race the user insert and fail its
foreign key. `users.user.provisioned` is emitted *after* the projection commits,
so the row is guaranteed to exist.

Both handlers are idempotent (`upsertFromClerk`, and `grantRole` behind two
partial unique indexes), which matters because the bus is at-most-once today and
at-least-once after a broker upgrade.

Webhook subscriptions handled: `user.created`, `user.updated`, `user.deleted`.
A deleted user is soft-deleted locally and `users.user.deactivated` fires, which
immediately invalidates their cached permissions.

## Session verification

`packages/auth/src/middleware/require-auth.middleware.ts`:

```ts
const payload = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties,          // from CLERK_AUTHORIZED_PARTIES
});
```

Networkless — the JWT signature is verified locally, no round trip to Clerk on
the request path.

Tokens are read from `Authorization: Bearer <token>` (mobile, server-to-server)
or the `__session` cookie (Clerk's browser SDKs).

`CLERK_AUTHORIZED_PARTIES` should list every frontend origin, so a token minted
for one of our apps cannot be replayed against an unrelated one:

```bash
CLERK_AUTHORIZED_PARTIES=https://hitbox.com,https://admin.hitbox.com,https://productmanager.hitbox.com
```

### After verification, before authorization

`requireAuth` also refuses, with distinct error codes:

| Condition | Response |
|---|---|
| no token | 401 `AUTH_UNAUTHENTICATED` |
| invalid/expired token | 401 `AUTH_INVALID_TOKEN` |
| no local account, or soft-deleted | 401 `AUTH_ACCOUNT_NOT_FOUND` |
| account suspended | 403 `AUTH_ACCOUNT_SUSPENDED` |
| synced email not verified | 403 `AUTH_EMAIL_UNVERIFIED` |

The last one is defence in depth — Clerk only mints a session after email
verification, but we re-check the value we synced.

## What lands on `req.auth`

```ts
interface AuthContext {
    accountId: string;              // local User.id — the input to authorization
    clerkUserId: string;
    email: string;
    sessionId: string | null;
    factorVerificationAge: [number, number] | null;   // Clerk's `fva` claim
}
```

No `role`. No `permissions`. A test asserts their absence, because a `role` field
reappearing here is exactly how the separation erodes.

### The `fva` claim and step-up

`fva` is Clerk's factor verification age, in minutes:

```text
fva = [ minutes since the FIRST factor was verified,
        minutes since the SECOND factor was verified ]

-1 in a slot = not applicable (e.g. no MFA enrolled)
```

This is the input to the step-up gate for sensitive capabilities
([09 — Security](09-security.md)). `iat` is deliberately **not** used: Clerk
session tokens are short-lived and silently refreshed, so `iat` is always seconds
old and would make every request look freshly authenticated.

If `fva` is absent, step-up **fails closed** — the request is refused with
`AUTHZ_STEP_UP_REQUIRED` and the client is expected to run Clerk's
re-verification flow and retry. Make sure your JWT template includes the claim.

## Configuration

```bash
CLERK_SECRET_KEY=sk_...
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
CLERK_AUTHORIZED_PARTIES=https://hitbox.com,https://admin.hitbox.com,https://productmanager.hitbox.com
```

## Related

- [01 — Architecture](01-architecture.md)
- [09 — Security](09-security.md)
- [10 — Frontend integration](10-frontend-integration.md)
