# Repository structure — two domains, one server

This repository hosts **two independent backends** — the mobile platform and the public website —
that run as **one Express process on one port**, distinguished by route namespace, each owning its
own database. There is no gateway, no proxy, no admin app, no RBAC layer. Knowing which routes
belong to which domain — and where their code/data boundary is — is the whole point of this
document.

```text
                    ┌──────────────────┐
                    │   Web / Mobile   │
                    └────────┬─────────┘
                             │
                             ▼
                 ┌───────────────────────┐
                 │     apps/backend      │   ONE process, ONE port (PORT, default 8000)
                 │  (single Express app) │
                 └───────────┬───────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
        /api/v1/*                    /app/web/v1/*
      (mobile platform               (public website /
       routes, existing               lead capture routes,
       modules)                       @hitbox/leads)
              │                             │
              ▼                             ▼
           App DB                      Website DB
        (DATABASE_URL)            (LEADS_DATABASE_URL)
```

| Domain | Route prefix | Owning package(s) | Database | Docs |
| --- | --- | --- | --- | --- |
| **Mobile platform** | `/api/v1/*` | `auth`, `users`, `products`, `discover`, `marketplace`, `collections`, `artist`, `claims` | `DATABASE_URL` (Neon) | [hitbox-architecture.md](hitbox-architecture.md) |
| **Public website** | `/app/web/v1/*` | `leads` | `LEADS_DATABASE_URL` (separate Neon project) | [leads-schema.md](leads-schema.md), [web-api-integration.md](web-api-integration.md) |

## Why one server, not two (or three)

An earlier iteration of this split the website into its own app (`apps/web`) plus a routing
gateway in front of both (`apps/gateway`). That's the right shape once there are genuinely
multiple independently-deployed services, but for two domains sharing one deploy target it was
pure overhead — three processes, three ports, a proxy layer whose only job was forwarding paths
unchanged. Collapsed back to one process: same route separation, same database separation, none
of the extra moving parts. Split it out again if/when the website's traffic or release cadence
actually needs to scale independently from the mobile API — the code is already separated cleanly
enough (see below) that doing so later is a deployment change, not a rewrite.

## How the one process stays two clean domains

`apps/backend/src/bootstrap.ts` is the single composition root. It builds the mobile platform's
router exactly as before (`buildRoutes(...)` → `apiRouter`), and separately calls
`createLeadsModule()` for the website, which needs **zero** of the platform's dependencies
(no `prisma`, no `eventBus` — it owns its own `PrismaClient` against its own database):

```ts
// apps/backend/src/bootstrap.ts
const apiRouter = buildRoutes({ auth: ..., users: ..., /* ...all mobile modules */ });
const leadsModule = createLeadsModule();
return { apiRouter, leadsRouter: leadsModule.router };
```

`apps/backend/src/app.ts` mounts both at their own prefix, each with its **own** rate limit:

```ts
app.use('/api/v1', createRateLimiter(), apiRouter);
app.use('/app/web/v1', createRateLimiter({ prefix: 'web', windowMs: 60_000, max: 20 }), leadsRouter);
```

The website's budget is deliberately tighter (20/min vs. the mobile API's 100/min) — these are
unauthenticated public forms with no CAPTCHA yet (see [leads-schema.md](leads-schema.md) §6.4).
`createRateLimiter`'s `prefix` option keeps the two budgets on separate Redis keys so they never
share or interfere with each other, even though they're now one process.

**The package boundary is still real, even though the process boundary isn't.**
`packages/leads` has no dependency on any platform package (`@hitbox/database`, `@hitbox/auth`,
etc.) and vice versa. A new package's name and its `prisma/` ownership still tell you which domain
it belongs to:

```text
packages/
  auth/        ┐
  users/       │
  products/    │  mobile platform — depend on @hitbox/database (the ONE
  discover/    │  shared Neon DB, hybrid multi-partial schema)
  marketplace/ │
  collections/ │
  artist/      │
  claims/      ┘

  leads/       ← public website — depends on ITS OWN Prisma client
                 (packages/leads/src/generated/prisma), own database.
                 Deliberately minimal: 4 models, one per public form. No
                 admin-side tables — see "Adding an admin panel" below.

  shared/      ← infrastructure BOTH domains use: logger, errors, event bus,
                 rate limiter, Redis client, env config. No business logic,
                 no assumption about which domain is calling it.
```

## One shared config module, disjoint variable names

Both domains import `@hitbox/shared` for logging, error handling, the Redis-backed rate limiter,
and environment validation — there's exactly one `env.ts` for the whole repo
(`packages/shared/config/env.ts`). Every field that's specific to one domain
(`DATABASE_URL`/`CLERK_*` for the mobile platform; `LEADS_DATABASE_URL`/`LEADS_DIRECT_URL`/
`IP_HASH_SALT` for the website) is declared **optional** at the shared-schema level — the module
that actually needs a value asserts it's present itself. See `createAuthModule` in
`packages/auth/src/module.ts` for the pattern: it throws a clear, specific error if
`CLERK_SECRET_KEY`/`CLERK_WEBHOOK_SIGNING_SECRET` are missing, rather than making every consumer
of `@hitbox/shared` configure Clerk. `IP_HASH_SALT` is soft — missing it logs a startup warning
and falls back to a dev-only value rather than blocking boot, since it's not a security-critical
secret (see `packages/leads/src/controller/lead-capture.controller.ts`).

Fields that are genuinely fine to share across domains (`REDIS_URL`, `LOG_LEVEL`,
`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` defaults) are just... shared — `/app/web/v1`'s rate
limiter overrides the shared defaults inline via `createRateLimiter({ max: 20, ... })` rather than
needing its own env vars.

## Adding an admin panel

Not built yet — intentionally. An earlier schema draft included `LeadNote`, `LeadActivity`,
`AdminProfile`, and `ExportLog` for exactly this, but they were **removed** rather than left as
unused scaffolding (see [leads-schema.md](leads-schema.md) §3) — there was no admin app to write
or read them, and speculative tables just rot. Bring them back at the point one is actually being
built, not before:

1. **New route namespace**, not a new app: mount a third router at e.g. `/app/admin/v1` in
   `apps/backend/src/app.ts`, same pattern as `/app/web/v1`. Only reach for a separate app/process
   if the admin panel's traffic, auth model, or release cadence genuinely needs independent
   scaling — the default here is "add a namespace," matching how the website domain itself is
   structured today.
2. **Re-add the admin-side models** to `packages/leads/prisma/schema.prisma`
   (`LeadNote`/`LeadActivity`/`AdminProfile`/`ExportLog`, a `LeadType` enum for the polymorphic
   `leadType`+`leadId` pointer — `contact`/`artist`/`partner`, not waitlist, which is a subscriber
   list, not a lead pipeline — and an `AdminRole` enum, e.g.
   `administrator`/`lead_manager`/`viewer`), then a real migration. `AdminProfile.userId` should
   be an external identity-provider id (no local `User` model needed); `LeadNote`/`LeadActivity`
   should use a polymorphic pointer with **no foreign key** — referential integrity there is the
   application's job, matching how the four existing lead tables' `assignedUserId` already works.
3. **Reuse `@hitbox/leads`'s service layer** for anything that reads/writes lead data — add
   admin-only repository/service methods (list/filter leads, add a note, change status, export)
   inside `@hitbox/leads` rather than duplicating Prisma access elsewhere, same
   "repository is the only thing that touches Prisma" rule the platform side already follows.
4. **Auth + RBAC**: whatever identity provider the admin panel uses, map it to `AdminProfile` the
   same way the platform's `IAccountLookup` port pattern maps Clerk users to `users` rows. Don't
   reuse `@hitbox/auth` as-is — it's Clerk-and-mobile-app-specific. A new, small
   `requireAdminAuth` middleware (checking `AdminProfile.role`), mounted only on the
   `/app/admin/v1` router, is the right scope — this is also where "RBAC + Authorization" from any
   earlier design sketch belongs: gating the admin routes specifically, not a cross-cutting layer
   in front of everything.
5. **Database**: share `@hitbox/leads`'s database — the dashboard is reading/writing that exact
   data, so there's no reason for a third one. The mobile platform's database never enters the
   picture regardless.

A manager panel, if it's a distinct surface from the admin panel (different role scope via
`AdminRole`), follows the identical shape — a fourth route namespace, sharing `@hitbox/leads`,
gated by `AdminRole` checks rather than a new database or a second copy of the service layer.
