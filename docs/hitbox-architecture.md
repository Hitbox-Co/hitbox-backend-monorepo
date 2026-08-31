# HitBox Backend — Architecture

> The single document that explains **how the backend is built, why it is built that way, and how every piece talks to every other piece.**

> **This document covers the mobile platform domain only** (`/api/v1/*`). The same `apps/backend`
> process also serves a second, independent domain — the public website's lead-capture API
> (`/app/web/v1/*` / `@hitbox/leads`), with its own database. See
> [repo-structure.md](repo-structure.md) for how the two domains share one process, and
> [leads-schema.md](leads-schema.md) / [web-api-integration.md](web-api-integration.md) for the
> website side specifically.

---

## 1. The Big Picture

HitBox uses a **Hybrid Modular Monolith**:

- **One deployable app** (`apps/backend`) — a single Express server.
- **Many isolated feature packages** (`packages/*`) — each one is a library shaped exactly like a future microservice.
- **One PostgreSQL database, one Prisma client, one migration history** — but the *schema definitions* are owned per-module (the "hybrid" part).

```text
                    ┌──────────────────────────────────────────────┐
                    │                 apps/backend                  │
  HTTP ──▶ app.ts ──▶ routes.ts (/api/v1) ──▶ bootstrap.ts          │
                    │        │                (composition root)    │
                    └────────┼─────────────────────┬────────────────┘
                             │ mounts routers      │ injects deps (ports)
                             ▼                      ▼
   ┌───────────────────────────── feature packages ─────────────────────────────┐
   │  own a table + routes        read-side (no DB, consume a port)   provider    │
   │  ──────────────────────      ─────────────────────────────      ─────────    │
   │  @hitbox/auth                @hitbox/discover   ─┐                            │
   │  @hitbox/users               @hitbox/marketplace │─ port ─▶ @hitbox/products  │
   │  @hitbox/products            @hitbox/collections ─┘         @hitbox/artist    │
   │  @hitbox/collections*                          (*owns table AND consumes a    │
   │  @hitbox/artist                                  port for its progress stat)  │
   └──────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
                       @hitbox/shared            @hitbox/database
                     (logger, errors,          (PrismaClient singleton,
                      env, event bus)           merged schema, migrations)
                                                        │
                                                        ▼
                                                 PostgreSQL (Neon)
```

**The rule that makes everything work:** modules never import each other's *implementation*. They communicate through:

1. **Events** on the shared event bus (`@hitbox/shared`) — fire-and-forget notifications.
2. **Ports (interfaces)** injected at bootstrap — synchronous questions one module asks another.
3. **Contracts** (types, constants, DTOs) exported from a module's `index.ts`.

When a module is extracted into a microservice, events become broker messages (Redis/RabbitMQ/Kafka) and ports become RPC/HTTP clients — **nothing inside the module changes.**

---

## 2. Repository Layout

```text
hitbox-backend/
├── apps/
│   └── backend/                  # The ONLY executable — Express server
│       └── src/
│           ├── index.ts          # Entry: loads .env FIRST, then imports server
│           ├── server.ts         # http listen + graceful shutdown
│           ├── app.ts            # createApp(): middleware + mounts /api/v1
│           ├── bootstrap.ts      # Composition root — wires all modules
│           └── routes.ts         # Mounts module routers under /api/v1
│
├── packages/
│   ├── auth/                     # Clerk auth, webhooks, requireAuth middleware
│   ├── users/                    # User profiles (local projection of Clerk users)
│   ├── products/                 # Catalog: Product, ProductImage, ProductHistory
│   ├── artist/                   # Owns Artist + ArtistCollection
│   │   └── src/{profile,collection}/   # profile = reserved; collection = capacity port
│   ├── discover/                 # Read-side feed for the Discover screen (no own tables)
│   ├── marketplace/              # Listing feed for the Marketplace screen (no own tables)
│   ├── collections/              # Owns BuyerCollection — a user's shelf, public/private showcase
│   ├── claims/                   # NFC verify/claim/transfer + provenance ledger (see docs/nfc-claim-verify-api.md)
│   └── shared/                   # Infrastructure ONLY — no business logic
│       ├── config/env.ts         # Zod-validated environment (fails fast at boot)
│       ├── logger/               # Pino logger + createModuleLogger(module)
│       ├── errors/app-error.ts   # AppError with static factories (badRequest, …)
│       ├── middleware/           # errorHandler + notFoundHandler (mounted LAST)
│       ├── events/               # IEventBus interface + InProcessEventBus
│       ├── utils/                # asyncHandler etc.
│       └── database/             # @hitbox/database — its own workspace package
│           ├── prisma/
│           │   ├── base.prisma       # generator + datasource   (source partial)
│           │   ├── enums.prisma      # shared enums             (source partial)
│           │   ├── schema.prisma     # ⚠ GENERATED — never edit
│           │   └── migrations/       # the ONE migration history
│           ├── scripts/merge-schema.mjs
│           └── src/index.ts          # PrismaClient singleton + re-exports
│
├── docs/                         # you are here
├── pnpm-workspace.yaml           # apps/*, packages/*, packages/shared/database
├── turbo.json
└── tsconfig.base.json
```

**Apps vs. libraries:** only `apps/backend` has `dev` / `build` / `start` scripts. Feature packages are libraries consumed as TypeScript source (`main: ./src/index.ts`) — `tsx` compiles everything on the fly in dev.

---

## 3. Anatomy of a Feature Module

Every module follows the same internal structure. Products is the fullest example:

```text
packages/products/
├── prisma/
│   ├── products.prisma           # models this module OWNS
│   └── artists.prisma
├── src/
│   ├── constants/                # module name, error codes, event names
│   ├── dto/                      # Zod schemas (input) + response shapes (output)
│   ├── domain/                   # enums, interfaces (ports), value objects
│   ├── repository/               # the ONLY place that touches Prisma
│   ├── service/                  # business logic; throws AppError; publishes events
│   ├── controller/               # HTTP glue: parse DTO → call service → res.json
│   ├── middleware/               # module-owned middleware (auth has requireAuth)
│   ├── events/                   # payload contracts it publishes / subscribers it registers
│   ├── module.ts                 # createXModule(deps) factory — the ONLY wiring
│   └── index.ts                  # public API — everything importable from outside
├── package.json                  # library: no dev/start scripts
└── tsconfig.json
```

**Layering (requests flow down, never sideways):**

```text
controller  →  service  →  repository  →  prisma
   │              │
   parses DTOs    throws AppError, publishes events
```

- **Controllers** never contain business logic; they parse/validate with Zod and shape the JSON envelope.
- **Services** never touch Express (`req`/`res`) and never touch Prisma directly.
- **Repositories** never throw domain errors — they return data; services decide what a missing row *means*.

### The module factory

Each module exposes exactly one way to construct it:

```ts
// packages/products/src/module.ts
export function createProductsModule(deps: { prisma: PrismaClient; eventBus: IEventBus }) {
    const repo = new ProductRepository(deps.prisma);
    const service = new ProductService({ products: repo, eventBus: deps.eventBus, logger });
    return {
        service,
        createRouter(requireAuth) { /* builds the Express router */ },
    };
}
```

Dependencies come **in** through the factory (constructor injection), never through direct imports of singletons from other feature modules. This is what makes a module testable in isolation and extractable later.

---

## 4. The Composition Root (`bootstrap.ts`)

The **only** file in the entire codebase where modules learn about each other:

```ts
export function bootstrap(): Router {
    const usersModule = createUsersModule({ prisma, eventBus });

    const authModule = createAuthModule({
        prisma,
        eventBus,
        accounts: usersModule.accountLookup,   // ← users implements auth's port
    });

    const productsModule = createProductsModule({ prisma, eventBus });

    const discoverModule = createDiscoverModule({
        catalog: productsModule.discovery,     // ← products implements discover's port
    });

    const marketplaceModule = createMarketplaceModule({
        catalog: productsModule.listings,      // ← products implements marketplace's port
    });

    // Artist provides ArtistCollection capacity; collections consumes it.
    const artistModule = createArtistModule({ prisma });

    const collectionsModule = createCollectionsModule({
        prisma,
        artistStats: artistModule.collectionStats,   // ← artist implements collections' port
    });

    return buildRoutes({
        auth: authModule.router,
        users: usersModule.createRouter(authModule.requireAuth),      // ← auth's middleware
        products: productsModule.createRouter(authModule.requireAuth),
        discover: discoverModule.router,                              // public — no auth
        marketplace: marketplaceModule.router,                        // public — no auth
        collections: collectionsModule.createRouter(authModule.requireAuth),
    });
}
```

Order matters and is deliberate:

1. **users** is created first — it needs nothing from other modules.
2. **auth** receives `usersModule.accountLookup` (the `IAccountLookup` **port** — see §6).
3. **discover** and **marketplace** receive their catalog ports from products.
4. **artist** is created before **collections**, which receives `artistModule.collectionStats` (the `IArtistCollectionStats` port).
5. Every router that needs authentication is built with `authModule.requireAuth`.

---

## 5. Auth Flow (Clerk)

Identity lives in **Clerk**. The backend keeps a *local projection* of each user in the `users` table so the rest of the system can use plain foreign keys.

### 5a. User lifecycle — webhooks + events

```text
 Clerk                    auth module                          users module
   │                          │                                     │
   │ POST /api/v1/auth/       │                                     │
   │  webhooks/clerk          │                                     │
   ├─────────────────────────▶│ 1. verify svix signature (raw body) │
   │                          │ 2. idempotency check                │
   │                          │    (AuthWebhookEvent, keyed svix-id)│
   │                          │ 3. translate Clerk payload ──▶ publish
   │                          │    auth.user.registered / updated / deleted
   │                          │                                     │
   │                          │            event bus                │
   │                          │ ───────────────────────────────────▶│ upsert / soft-delete
   │◀── 200 {received:true} ──┤                                     │   User row
```

Key points:

- The webhook handler needs the **raw request bytes** for signature verification — `app.ts` captures them via `express.json({ verify })` into `req.rawBody`.
- Replayed deliveries are ignored (a row in `auth_webhook_events` = already processed).
- **Nothing outside the auth module ever sees a Clerk payload shape.** The event payloads (`UserRegisteredPayload` etc.) are the contract.

### 5b. Request authentication — `requireAuth`

```text
Request ── Bearer <session JWT> ──▶ requireAuth
                                       │ 1. verifyToken()   (networkless, @clerk/backend)
                                       │ 2. accounts.findByClerkUserId(sub)   ← IAccountLookup port
                                       │ 3. status check (SUSPENDED → 403, DELETED → 401)
                                       │ 4. req.auth = { accountId, clerkUserId, email, role, sessionId }
                                       ▼
                                  route handler reads req.auth
```

Downstream code depends only on `AuthContext` (`req.auth`) — never on Clerk.

---

## 6. Ports & Adapters (how auth asks users a question)

Auth needs to resolve a Clerk user ID to a local account *synchronously* during every authenticated request. It cannot import the users module (that would create a hard coupling), so:

- **Auth defines the port** — `IAccountLookup` in `packages/auth/src/domain/interfaces/`:
  ```ts
  interface IAccountLookup {
      findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null>;
  }
  ```
- **Users implements the adapter** — `UserAccountLookup` in `packages/users/src/domain/`, mapping `User.state` + `User.deletedAt` → `AccountStatus`.
- **Bootstrap connects them** — `createAuthModule({ accounts: usersModule.accountLookup })`.

Package-level dependency direction: `users → auth` (users imports auth's *types and constants*). Auth never imports users. When users becomes its own service, `UserAccountLookup` is reimplemented as an HTTP/RPC client and bootstrap swaps it in — auth is untouched.

The same pattern repeats wherever one module needs a synchronous answer from another. **The consumer defines the port, the provider implements the adapter, bootstrap connects them:**

| Port (defined by consumer) | Adapter (implemented by provider) | Purpose |
|---|---|---|
| `IAccountLookup` (auth) | `UserAccountLookup` (users) | resolve Clerk user → local account on every authenticated request |
| `IProductDiscovery` (discover) | `ProductDiscoveryAdapter` (products) | lightweight product cards for the Discover feed |
| `IListingCatalog` (marketplace) | `MarketplaceListingAdapter` (products) | listing cards (price, artist, badge) for the Marketplace feed |
| `IArtistCollectionStats` (collections) | `ArtistCollectionStatsAdapter` (artist) | `ArtistCollection` capacity (`Σ maximumLimit`) for the collection-progress stat |

Note what this buys discover and marketplace: those modules have **zero database knowledge** — no `@hitbox/database` dependency at all. Each defines its own screen-level vocabulary (`DiscoverSection`: `trending` / `new_releases` / `top_creators`; `MarketplaceCategory`: `cards` / `figures` / `apparel` / …) and the products adapters map that to storage concerns (`MarketplaceStatus`, `ProductCategory` sets, ordering). Extracting either into a service later means swapping one adapter for an HTTP client.

**Collections is the third flavor of module:** it *owns a table* (`BuyerCollection`) like products/users, *and* consumes a port. Its rows embed a product card, read by traversing the `product` relation **declared in its own partial** (`collections.prisma`) — a documented, deliberate shortcut at the database layer. On extraction, that include becomes a products-port call.

For the **collection-progress stat** the work is split cleanly across the boundary:

- **collections** (owns `BuyerCollection`) aggregates the user's own rows: how many items total, which distinct `ArtistCollection`s they have products from, and how many of their items belong to a collection. This is pure own-table work.
- **artist** (owns `ArtistCollection`) answers one question through the `IArtistCollectionStats` port: given those collection ids, what is each one's `maximumLimit`? Collections sums them for the denominator.

Neither module reaches into the other's table. `progress = ownedInCollections / Σ maximumLimit`, computed in the collections service from the two halves. This is why `artist` exists as its own package rather than a folder under products: the artist domain (profile + collections) is a distinct future service, and the progress feature already treats it as one across a port.

---

## 7. Events

`@hitbox/shared/events` exports:

- `IEventBus` — `publish<T>(event, payload)` / `subscribe<T>(event, handler)`.
- `InProcessEventBus` — today's implementation: handlers run on `setImmediate` (publisher is never blocked), a throwing handler is logged and isolated.
- `eventBus` — the singleton every module receives via DI.

Current event catalog:

| Event | Publisher | Subscriber | Payload |
|---|---|---|---|
| `auth.user.registered` | auth (webhook) | users (upsert) | `UserRegisteredPayload` |
| `auth.user.updated` | auth (webhook) | users (upsert) | `UserUpdatedPayload` |
| `auth.user.deleted` | auth (webhook) | users (soft delete) | `UserDeletedPayload` |
| `products.product.created` | products | — (future: notifications, search index) | `{ productId, productCode }` |
| `products.product.updated` | products | — | `{ productId }` |
| `products.product.archived` | products | — | `{ productId }` |

**Delivery semantics today:** in-process, at-most-once, no retries. Handlers are written idempotently (upserts, guarded updates) so that upgrading to a broker (at-least-once + retries) requires changing **one line** — the `eventBus` instantiation in shared.

---

## 8. Hybrid Prisma Architecture

Nobody edits `schema.prisma`. Each module owns its models in its own partial:

```text
packages/shared/database/prisma/base.prisma    ← generator + datasource (pooled + direct URLs)
packages/shared/database/prisma/enums.prisma   ← shared enums (used across modules)
packages/auth/prisma/auth.prisma               ← AuthWebhookEvent
packages/users/prisma/users.prisma             ← User
packages/products/prisma/products.prisma       ← Product, ProductHistory, ProductImage
packages/artist/prisma/artist.prisma           ← Artist, ArtistCollection (has maximumLimit)
packages/claims/prisma/claims.prisma           ← ProductClaim, BlockchainLedger
packages/collections/prisma/collections.prisma ← BuyerCollection
```

### The merge pipeline

`packages/shared/database/scripts/merge-schema.mjs`:

1. Collects shared partials (sorted by filename), then every `packages/<module>/prisma/*.prisma` (packages alphabetically, files alphabetically) — **deterministic order** so the generated file is stable in git diffs.
2. Concatenates them with `// ───── source:` markers.
3. **Rejects duplicate model/enum declarations** — every model has exactly one owner.
4. Writes `packages/shared/database/prisma/schema.prisma`.

Cross-module relations (e.g. `Product.owner → User`) work because Prisma sees one merged file. That is intentional coupling *at the database layer only* — the extraction path for a module includes carving its tables out into its own database.

### Commands (run from repo root)

| Command | What it does |
|---|---|
| `pnpm db:merge` | merge partials → `schema.prisma` |
| `pnpm db:validate` | merge + `prisma validate` |
| `pnpm db:generate` | merge + regenerate the Prisma client |
| `pnpm db:migrate` | merge + `prisma migrate dev` (creates + applies a migration) |
| `pnpm db:deploy` | `prisma migrate deploy` (CI/production) |
| `pnpm db:studio` | Prisma Studio on the merged schema |
| `pnpm db:seed` | idempotent dev seed across all tables (real accounts preserved) |

**Neon note:** `DATABASE_URL` is the *pooled* endpoint (runtime queries); `DIRECT_URL` is the *unpooled* endpoint (required by migrations). `base.prisma` declares both.

### Golden rules

1. Never edit `schema.prisma` — edit the module's partial, re-run `pnpm db:merge`.
2. Never run `prisma migrate` against a partial — always through the `db:*` scripts.
3. A model lives in exactly ONE partial. Shared enums live in `enums.prisma`.
4. Modules import Prisma types from **`@hitbox/database`**, never from `@prisma/client` directly.

---

## 9. Request Lifecycle (end to end)

```text
1. index.ts        loads root .env (before ANY app import — env.ts validates at import time)
2. app.ts          cors → helmet → morgan → express.json (captures rawBody) → urlencoded
3. routes.ts       /api/v1/{health, auth, users, products, discover, marketplace, collections}
4. requireAuth     (protected routes only) verifies JWT, attaches req.auth
5. controller      Zod-parses input → calls service
6. service         business rules; throws AppError; publishes events
7. repository      Prisma queries
8. errorHandler    (mounted LAST) — the single error boundary:
      ZodError                    → 422 VALIDATION_ERROR + field details
      AppError (operational)      → its statusCode + { code, message, details }
      anything else               → 500 INTERNAL_ERROR (stack logged, hidden in prod)
```

Error envelope — everything non-2xx has this exact shape:

```json
{ "error": { "code": "PRODUCTS_NOT_FOUND", "message": "Product not found", "details": null } }
```

---

## 10. Adding a New Module (checklist)

Using `orders` as the example:

1. `packages/orders/` with the standard folder skeleton (§3) and a `package.json` copied from products (library — no dev/start scripts, `main: ./src/index.ts`).
2. Models in `packages/orders/prisma/orders.prisma`; shared enums go in `enums.prisma`.
3. `pnpm db:migrate` — merge picks the new partial up automatically.
4. Implement `repository → service → controller`, DTOs in `dto/`, error codes + event names in `constants/`.
5. `createOrdersModule(deps)` in `module.ts`; export the public surface from `index.ts`.
6. Wire it in `apps/backend/src/bootstrap.ts` and mount its router in `routes.ts`.
7. Needs data from another module? Subscribe to its **events** or define a **port** and have bootstrap inject the adapter. Never import another module's service/repository classes directly.
8. `pnpm install` (add `@hitbox/orders: workspace:*` to the backend's dependencies).

---

## 11. Microservice Extraction Path

When a module (say `products`) outgrows the monolith:

1. Move `packages/products` → `apps/product-service` — the internal structure already matches a standalone service.
2. Give it its own `prisma/` datasource + migration history; carve its tables out of the shared DB.
3. Replace in-process wiring:
   - `eventBus` → broker-backed `IEventBus` implementation (same interface),
   - ports it *implements* for others → thin HTTP/RPC endpoints,
   - ports it *consumes* → HTTP/RPC client adapters.
4. Cross-module Prisma relations become IDs-only references (already the convention at the API layer).
5. Add Dockerfile + CI/CD; the monolith's `bootstrap.ts` drops the module and points at the remote instead.

The whole point of the architecture is that **step 1 requires zero internal refactoring.**

---

## 12. Environment & Configuration

`packages/shared/config/env.ts` — Zod-validated, fails fast at boot with a readable report:

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | no (default `development`) | `development` / `qa` / `pre-production` / `production` |
| `PORT` | no (default `4000`) | HTTP port |
| `LOG_LEVEL` | no (default `info`) | pino level |
| `DATABASE_URL` | **yes** | Neon **pooled** connection (runtime) |
| `DIRECT_URL` | **yes** (for migrations) | Neon **unpooled** connection |
| `CLERK_SECRET_KEY` | **yes** | Clerk backend key (`sk_…`) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **yes** | svix signing secret (`whsec_…`) from the Clerk webhook endpoint |
| `CLERK_AUTHORIZED_PARTIES` | no | comma-separated origins for azp validation |
| `REDIS_URL` | no | Redis for the distributed rate limiter (in-memory fallback if unset) |
| `RATE_LIMIT_MAX` | no (default `100`) | requests allowed per window per IP |
| `RATE_LIMIT_WINDOW_MS` | no (default `60000`) | rate-limit window length; default = 100 req / 60s ≈ 1.6 req/sec |

The root `.env` is the single source; `apps/backend/src/index.ts` loads it before anything else is imported.
