# HitBox Backend — Getting Started

From zero to a running, authenticated API in ~10 minutes.

---

## 1. Prerequisites

- **Node.js ≥ 20**
- **pnpm 11** (`corepack enable` or `npm i -g pnpm`)
- A **Neon** PostgreSQL project (or any Postgres)
- A **Clerk** application (Dashboard → API Keys)

## 2. Install

```bash
pnpm install
```

## 3. Environment

Create `.env` at the **repo root** (it is git-ignored):

```dotenv
PORT=8080
NODE_ENV=development

# Neon: pooled URL for runtime queries
DATABASE_URL=postgresql://user:pass@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
# Neon: SAME url without "-pooler" — migrations need a direct connection
DIRECT_URL=postgresql://user:pass@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require

# Clerk (Dashboard → API Keys)
CLERK_SECRET_KEY=sk_test_...
# Clerk (Dashboard → Webhooks → your endpoint → Signing Secret)
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
# optional, comma-separated frontend origins for azp validation
# CLERK_AUTHORIZED_PARTIES=http://localhost:3000
```

The env is validated at boot ([packages/shared/config/env.ts](../packages/shared/config/env.ts)) — a missing variable prints a readable report and exits instead of crashing at request time.

## 4. Database

```bash
pnpm db:migrate      # merge module schemas → validate → create/apply migration → generate client
```

Day-to-day variants:

```bash
pnpm db:merge        # just regenerate schema.prisma from the partials
pnpm db:generate     # merge + regenerate the Prisma client (after pulling schema changes)
pnpm db:studio       # browse data
pnpm db:seed         # fill the database with realistic dummy data (see below)
```

### Dummy data

`pnpm db:seed` populates **every table** with realistic development data: 5 users, 6 artists, 8 collections, 16 products (with images, spread across trending / new releases / top creators), plus claims, ledger entries, ownership history and buyer collections — so the discover feed, product listings, search and detail endpoints all return real-looking responses immediately.

Each `ArtistCollection` is seeded with a `maximumLimit` (the progress denominator) and one seed user (`liam_collects`) owns products across two collections, so `GET /collections/me/stats` returns meaningful numbers (owned 3 / total 20 = 15%).

It is **idempotent**: every run wipes and re-creates the catalog data. Real accounts are safe — only users whose `clerkUserId` starts with `seed_` are touched. The script lives at [packages/shared/database/prisma/seed.ts](../packages/shared/database/prisma/seed.ts); edit the `USERS` / `ARTISTS` / `PRODUCTS` arrays at the top to shape the data.

> Never edit `packages/shared/database/prisma/schema.prisma` — it is generated.
> Edit the owning module's partial (e.g. `packages/products/prisma/products.prisma`) and run `pnpm db:migrate`.

## 5. Run

```bash
pnpm --filter backend dev    # backend only (tsx watch)
# or
pnpm dev                     # all apps via turbo
```

```
🚀 Server running on http://localhost:8080
```

Sanity checks:

```bash
curl http://localhost:8080/api/v1/health
curl "http://localhost:8080/api/v1/products?limit=5"
```

## 6. Wire up Clerk (one-time)

Sign-in works immediately, but a user only gets a **local database row** when Clerk's webhook reaches the backend:

1. Expose your local server (e.g. `ngrok http 8080`) or use your deployed URL.
2. Clerk Dashboard → **Webhooks → Add Endpoint** → `https://<host>/api/v1/auth/webhooks/clerk`.
3. Subscribe to **`user.created`**, **`user.updated`**, **`user.deleted`**.
4. Copy the endpoint's **Signing Secret** into `CLERK_WEBHOOK_SIGNING_SECRET` and restart.

Flow after that: sign-up in your frontend → Clerk fires `user.created` → auth module verifies + publishes `auth.user.registered` → users module inserts the `User` row → `GET /api/v1/auth/me` works.

Until the webhook is configured, authenticated calls return `401 AUTH_ACCOUNT_NOT_FOUND` (valid token, no local account).

## 7. Calling protected endpoints

Grab a session token from your frontend (`await session.getToken()` in Clerk's SDK) and:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/v1/users/me
```

## 8. Where to go next

| I want to… | Read |
|---|---|
| Understand the architecture, module anatomy, DI, events | [hitbox-architecture.md](hitbox-architecture.md) |
| See every endpoint, params, and error codes | [api-reference.md](api-reference.md) |
| Understand auth validation + run the auth tests (`pnpm --filter @hitbox/auth test`) | [auth-testing.md](auth-testing.md) |
| Add a new feature module | [hitbox-architecture.md §10](hitbox-architecture.md#10-adding-a-new-module-checklist) |
| Change the database schema | [hitbox-architecture.md §8](hitbox-architecture.md#8-hybrid-prisma-architecture) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Boot exits with `Invalid environment configuration` | a required `.env` variable is missing — the report lists which |
| `P1001 can't reach database` during migrate | `DIRECT_URL` missing or still contains `-pooler`; Neon may take a few seconds to wake from idle |
| `401 AUTH_ACCOUNT_NOT_FOUND` with a valid login | Clerk webhook not configured yet (step 6) — no local `User` row |
| `401 AUTH_WEBHOOK_INVALID_SIGNATURE` on webhooks | wrong `CLERK_WEBHOOK_SIGNING_SECRET`, or the endpoint URL in Clerk doesn't match |
| Prisma types missing / stale after schema change | run `pnpm db:generate` |
| `Duplicate declaration "model X"` on db:merge | two partials declare the same model — every model has exactly one owner |
