# HitBox Authentication & Authorization

One Clerk instance for identity. One database for authorization. One backend that
is the final authority on every decision.

```text
Clerk  →  Identity  →  Database User  →  Roles  →  Permissions  →  Scope/Policy  →  API decision
(WHO)                                   (WHAT)
```

## The one-paragraph version

Clerk answers **"who is this?"** — sign-up, sign-in, verification, MFA, sessions,
recovery. It is the only identity system, shared by every frontend, and it stores
no authorization data. Our database answers **"what may they do?"** — a user holds
many roles, each role bundles permissions, each permission is
`resource:action:scope`, and a scope is checked against the specific row being
touched. `@hitbox/auth` does the first half, `@hitbox/authz` does the second, and
they never mix.

## Documents

| # | Document | What it covers |
|---|---|---|
| 01 | [Architecture](01-architecture.md) | The separation of concerns, request flow, module boundaries |
| 02 | [Permission model](02-permission-model.md) | Naming convention, the catalog, avoiding permission explosion |
| 03 | [Roles](03-roles.md) | Role design, the full seed catalog, multi-role users, avoiding role explosion |
| 04 | [Scopes & tenancy](04-scopes-and-tenancy.md) | own/organization/any, organization isolation, org-scoped resources |
| 05 | [Clerk integration](05-clerk-integration.md) | One instance, webhooks, provisioning, what does *not* go in Clerk metadata |
| 06 | [Backend authorization](06-backend-authorization.md) | The service, the middleware, permission vs policy checks, examples |
| 07 | [Permission caching](07-caching.md) | Redis, the two tiers, invalidation strategy, TTLs |
| 08 | [Audit logging](08-audit-logging.md) | What is recorded, the schema, retention, alerting |
| 09 | [Security](09-security.md) | Default deny, least privilege, SUPER_ADMIN, step-up, threat notes |
| 10 | [Frontend integration](10-frontend-integration.md) | Consuming `/authz/me`, gating UI, why it is UX only |
| 11 | [API surfaces](11-api-surfaces.md) | hitbox.com vs admin.hitbox.com vs productmanager.hitbox.com vs mobile |
| 12 | [Operations](12-operations.md) | Migrating, seeding, adding permissions, runbooks, retiring `User.role` |

## Quick start

```bash
pnpm db:migrate      # apply the authorization migration
pnpm authz:seed      # reconcile the role/permission catalog into the database
```

Nothing works before the seeder runs — with no permission rows, every check
correctly denies. Bootstrap the first break-glass account:

```bash
pnpm authz:seed -- --super-admin=you@hitbox.com
```

(The account must have signed in through Clerk at least once, so a local user row
exists.)

## The three things to remember

**1. Ask for a permission, never a role.** There is no `if (role === 'ADMIN')`
anywhere, and adding one is the single change most likely to be rejected in
review. Roles are configuration; code depends on capabilities.

```ts
// ✅
requirePermission('product', 'update', { resource: (req) => products.refFor(req.params.id) })

// ❌
if (user.role === 'PRODUCT_MANAGER') { ... }
```

**2. Two checks, not one.** "May you update products?" and "may you update *this*
product?" are different questions. The first is a cheap gate; the second needs
the row. Skipping the second is how tenant isolation breaks.

**3. The frontend decides what to *show*. The backend decides what to *allow*.**
Hiding a Delete button is a courtesy. `DELETE /v1/products/:id` is where security
happens.

## Where the code lives

| Concern | Location |
|---|---|
| Clerk verification, sessions | `packages/auth/src/middleware/require-auth.middleware.ts` |
| Decision core (pure functions) | `packages/authz/src/domain/policy/scope-policy.ts` |
| Permission catalog | `packages/authz/src/domain/catalog/permission-catalog.ts` |
| Role catalog | `packages/authz/src/domain/catalog/role-catalog.ts` |
| Central service | `packages/authz/src/service/authorization.service.ts` |
| Route guard | `packages/authz/src/middleware/require-permission.middleware.ts` |
| Role administration + escalation guards | `packages/authz/src/service/role-assignment.service.ts` |
| Permission cache | `packages/authz/src/cache/permission-cache.ts` |
| Schema | `packages/authz/prisma/authz.prisma` |
| API surfaces | `apps/backend/src/surfaces/` |
| Composition root | `apps/backend/src/bootstrap.ts` |
