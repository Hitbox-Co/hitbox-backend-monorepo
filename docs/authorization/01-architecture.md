# 01 — Architecture

## The core principle

Authentication and authorization are separate systems with separate owners.

| | Authentication | Authorization |
|---|---|---|
| Question | Who is this? | What may they do? |
| Owner | Clerk + `@hitbox/auth` | Our database + `@hitbox/authz` |
| Attached to | `req.auth` | `req.authz` |
| Changes when | Someone signs in/out | An administrator grants a role |
| Source of truth | Clerk | Postgres |

They meet in exactly one place: `req.auth.accountId` is the input to loading
`req.authz.principal`. Nothing else crosses.

### Why they are kept apart

Merging them is the standard mistake, and it fails in three specific ways:

- **Stale access.** Roles baked into a session token stay valid until the token
  expires. Revoking a role has to take effect on the *next request*, which means
  the decision must read live state.
- **Bloated tokens.** A user with several roles across several organizations has
  a permission set far too large for a JWT. Once you start trimming it to fit,
  the frontend and backend disagree about what the user can do.
- **Vendor lock-in of business rules.** Clerk is excellent at identity. Modelling
  "a product manager may publish products belonging to their organization" in
  someone else's metadata store means every authorization question becomes an
  API call to a system that cannot join against our data.

## Request flow

```text
                    ┌──────────────────────────────────────────┐
  hitbox.com        │                                          │
  admin.hitbox.com  │            api.hitbox.com                │
  productmanager…   │                                          │
  mobile app        │  ┌────────────────────────────────────┐  │
        │           │  │ API SURFACE  (CORS, rate limit,    │  │
        │  Clerk    │  │               surface tag)         │  │
        │  session  │  └──────────────┬─────────────────────┘  │
        └──────────►│                 ▼                        │
                    │  ┌────────────────────────────────────┐  │
                    │  │ requireAuth   @hitbox/auth         │  │
                    │  │  · verify Clerk JWT (networkless)  │  │
                    │  │  · load local account by clerkId   │  │
                    │  │  · reject deleted/suspended/unverified│
                    │  │  → req.auth  { accountId, … }      │  │
                    │  └──────────────┬─────────────────────┘  │
                    │                 ▼                        │
                    │  ┌────────────────────────────────────┐  │
                    │  │ requirePermission   @hitbox/authz  │  │
                    │  │  1. load principal (L1→L2→Postgres)│  │
                    │  │  2. resolve organization context   │  │
                    │  │  3. PERMISSION CHECK  (capability) │  │
                    │  │  4. step-up gate if sensitive      │  │
                    │  │  5. POLICY CHECK      (this row)   │  │
                    │  │  6. audit                          │  │
                    │  └──────────────┬─────────────────────┘  │
                    │                 ▼                        │
                    │        controller → service → repo       │
                    └──────────────────────────────────────────┘
                                      │
                       ALLOW ─────────┴───────── DENY → 403
```

Steps 3 and 5 are the two halves described in
[06 — Backend authorization](06-backend-authorization.md). Everything before them
is plumbing; everything after them assumes the decision has been made.

## Module boundaries

```text
@hitbox/shared      config, logger, errors, event bus, redis, rate limit
      ▲
      ├── @hitbox/auth      Clerk verification, webhooks   →  requireAuth
      │        ▲
      ├── @hitbox/authz     roles, permissions, scopes,    →  requirePermission
      │        ▲            organizations, audit, cache
      │        │
      └── @hitbox/users, products, collections, claims, …
                    ▲
              apps/backend  (composition root)
```

Dependencies point one way. `authz` depends on `auth` (it reads the
authenticated principal) but `auth` knows nothing about `authz` — you can delete
the authorization module and authentication still works.

### Ports, not imports

Modules never reach into each other. Two ports matter here:

| Port | Declared by | Implemented by |
|---|---|---|
| `IAccountLookup` | `auth` | `users` (`UserAccountLookup`) |
| `IUserDirectory` | `authz` | `users` (`UserDirectory`) |

Both are injected in `apps/backend/src/bootstrap.ts`. When `users` becomes its
own service, these become HTTP clients and no authorization logic changes.

`authz` deliberately does **not** import `users`, even for its event
subscriptions — the composition root wires those instead:

```ts
eventBus.subscribe(USERS_EVENTS.USER_PROVISIONED, (payload) =>
    authzModule.roleAssignments.ensureDefaultRole(payload.userId),
);
```

That keeps the dependency graph acyclic while still guaranteeing that a new user
gets the baseline role the moment their local row exists.

## What lives where

| Layer | Responsibility | Example |
|---|---|---|
| `domain/catalog/` | What permissions and roles *exist* | `permission-catalog.ts` |
| `domain/policy/` | The decision, as pure functions | `scope-policy.ts` |
| `repository/` | Reading grants out of Postgres | `authz.repository.ts` |
| `cache/` | Making that read cheap | `permission-cache.ts` |
| `service/` | Orchestration, invalidation, audit | `authorization.service.ts` |
| `middleware/` | Applying it to an HTTP request | `require-permission.middleware.ts` |

The decision core has no I/O, no Express and no Prisma, which is why it can be
tested exhaustively — see `packages/authz/tests/scope-policy.test.ts`.

## The database is the source of truth

```text
User ──< UserRoleAssignment >── Role ──< RolePermission >── Permission
           │                      │
           └── Organization ──────┘        organizationId = NULL → platform-wide
```

Caches are derived state and always safe to throw away. Clerk holds no
authorization data. The frontend holds a *description* of authorization, for
rendering only.

## Related

- [02 — Permission model](02-permission-model.md)
- [06 — Backend authorization](06-backend-authorization.md)
- [11 — API surfaces](11-api-surfaces.md)
