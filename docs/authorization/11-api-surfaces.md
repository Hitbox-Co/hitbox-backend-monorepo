# 11 — API surfaces

How `hitbox.com`, `admin.hitbox.com`, `productmanager.hitbox.com` and the mobile
app are kept distinct while sharing one backend, one Clerk instance and one
permission model.

## The four surfaces

| Surface | Clients | Mount | Auth |
|---|---|---|---|
| `public` | anyone | `/api/v1/…` | none |
| `app` | `hitbox.com`, mobile | `/api/v1/…` | Clerk session |
| `admin` | `admin.hitbox.com` | `/api/v1/admin/…` | Clerk session + platform permissions |
| `manage` | `productmanager.hitbox.com` | `/api/v1/manage/…` | Clerk session + tenant permissions |

`public` and `app` share the root mount, so **every existing client path is
unchanged**: `/api/v1/products`, `/api/v1/collections/me`, `/api/v1/claims/:tagId`
all still work exactly as before.

## A surface is not an authorization mechanism

Permissions are. Enforcement is identical no matter where a request comes from.

A surface adds four things that are genuinely per-client:

**1. Reachability.** Role administration is not mounted on the app surface, so a
bug in a customer-facing route cannot reach it. Defence in depth, not the primary
control.

**2. CORS.** The admin console and the public storefront are different trust
boundaries. A single global `origin: '*'` means any page a signed-in operator
visits can attempt administrative calls with their cookie.

**3. Rate limits.** Admin and manage run at half the budget, in separate Redis
buckets, so heavy anonymous catalog traffic cannot exhaust an operator's budget —
and scripted abuse of admin endpoints stands out.

**4. Audit context.** Every audit row carries `surface`, so "who refunded this,
and from where?" is answerable. The same action from admin.hitbox.com and from the
mobile app are distinguishable.

The surface tag is set by **which router tree the request landed in**, never by a
client-supplied header — `withSurface` overwrites whatever the caller sent.

## Layout

```text
apps/backend/src/
├── app.ts                        express app, body parsing, error boundary
├── bootstrap.ts                  composition root — the only place modules meet
├── routes.ts                     mounts surfaces, applies per-surface CORS/limits/tag
├── middleware/
│   └── surface-cors.middleware.ts
└── surfaces/
    ├── surface.ts                names, mounts, origin allowlists, rate multipliers
    ├── public.surface.ts         health, webhooks, discover, marketplace, verify, ledger
    ├── app.surface.ts            authz manifest, users, products, collections, claims
    ├── admin.surface.ts          authz manifest + admin, organizations, products, users
    └── manage.surface.ts         authz manifest, organizations, products
```

Each surface file is a small function from routers to a router — the interesting
content is the doc comment explaining who it serves and why a given router is (or
is not) on it.

## Mounting

```ts
export function buildRoutes(routers: SurfaceRouters): ExpressRouter {
    const api = Router();
    api.use('/admin',  mountSurface(SURFACES.ADMIN,  routers.admin));
    api.use('/manage', mountSurface(SURFACES.MANAGE, routers.manage));
    api.use('/',       mountSurface(SURFACES.PUBLIC, routers.public));
    api.use('/',       mountSurface(SURFACES.APP,    routers.app));
    return api;
}
```

Order matters: the specific prefixes are mounted first so `/admin/…` is not
swallowed by the root-mounted app surface.

```ts
function mountSurface(name: SurfaceName, router: ExpressRouter) {
    const wrapper = Router();
    wrapper.use(surfaceCors(name, allowedOriginsFor(name)));       // 1. reject bad origins first
    wrapper.use(createRateLimiter({ max: …, prefix: `api:${name}` })); // 2. then spend budget
    wrapper.use(withSurface(name));                                 // 3. tag before authorization
    wrapper.use(router);
    return wrapper;
}
```

CORS runs first so a rejected origin never consumes rate-limit budget;
`withSurface` runs before any authorization middleware so the tag is available
when a decision is audited.

## One router, several surfaces

The **same** products router is mounted on app, admin and manage. That is safe
precisely because the routes carry permission and policy checks rather than
relying on where the request came from:

```text
PATCH /api/v1/products/:id             artist        → product:update:own
PATCH /api/v1/manage/products/:id      prod manager  → product:update:organization
PATCH /api/v1/admin/products/:id       platform admin→ product:update:any
```

One implementation, three legitimate answers, decided by grants rather than by
URL prefix. Duplicating the endpoint per surface is how the three copies drift
apart, and drift in authorization code is how holes appear.

## CORS configuration

```bash
CORS_APP_ORIGINS=https://hitbox.com,https://www.hitbox.com
CORS_ADMIN_ORIGINS=https://admin.hitbox.com
CORS_MANAGE_ORIGINS=https://productmanager.hitbox.com
```

Unset means "any origin", which preserves the behaviour this app already had so
nothing breaks before the environment is configured — but it is logged as a
warning in production, because shipping without an admin allowlist is a real
finding, not a preference.

Requests with **no** `Origin` (mobile apps, server-to-server, curl) are always
allowed through: CORS is a browser control, and blocking them here would break the
mobile client while stopping no attacker.

Allowed request headers include `X-Organization-Id` and `X-Hitbox-Surface`;
`credentials: true` is set on the configured surfaces because the browser consoles
authenticate with Clerk's `__session` cookie.

## Mobile

Mobile is **not** a separate surface. A phone and a browser are the same principal
with the same permissions; duplicating endpoints per device is how they drift.
Mobile calls the app surface with a Bearer token, sends no `Origin`, and renders
differently — which is the client's job, driven by `/authz/me`.

## Adding a surface

Say an internal ops tool at `ops.hitbox.com`:

1. Add `OPS: 'ops'` to `SURFACES`, plus its mount, rate multiplier and origin env
   var in `surface.ts`.
2. Create `surfaces/ops.surface.ts` mounting only the routers it needs.
3. Mount it in `buildRoutes` **before** the root mounts.
4. Set `CORS_OPS_ORIGINS`.

No new Clerk instance. No new permission kind. Ops staff get roles, like everyone
else.

## Route inventory

### `public` — `/api/v1`

```text
GET  /health
POST /auth/webhooks/clerk            Clerk → svix-signed, idempotent
POST /auth/registration/validate     pre-flight before Clerk sign-up
GET  /discover                       feed
GET  /marketplace                    listings
GET  /verify/:tagId                  NFC authenticity
GET  /ledger/:tagId                  provenance chain
```

### `app` — `/api/v1`

```text
GET    /authz/me                     permission manifest
GET    /users/me                     profile:read
PATCH  /users/me                     profile:update
GET    /users/:id                    public profile card (unauthenticated)
GET    /products…                    public catalog reads
POST   /products                     product:create
PATCH  /products/:id                 product:update  + resource policy
DELETE /products/:id                 product:delete  + resource policy
GET    /collections/me               collection:read
GET    /collections/me/stats         collection:read
PATCH  /collections/me/:productId    collection:update
GET    /collections/user/:userId     public showcase
POST   /claims/:tagId                claim:create
POST   /claims/:tagId/confirm        claim:create
```

### `admin` — `/api/v1/admin`

```text
GET    /authz/me
GET    /authz/roles                            role:read
GET    /authz/permissions                      permission:read
GET    /authz/users/:userId/roles              role:read
POST   /authz/users/:userId/roles              role:assign   (sensitive → step-up + audit)
DELETE /authz/users/:userId/roles/:roleKey     role:revoke   (sensitive)
GET    /authz/audit-logs                       audit-log:read
POST   /organizations                          organization:create
GET    /organizations/:id                      organization:read
PATCH  /organizations/:id                      organization:update
DELETE /organizations/:id                      organization:delete (sensitive)
GET    /organizations/:id/members               organization-member:read
POST   /organizations/:id/members               organization-member:invite
DELETE /organizations/:id/members/:userId       organization-member:delete (sensitive)
+ the products and users routers, reached via *:any permissions
```

### `manage` — `/api/v1/manage`

```text
GET  /authz/me
GET  /organizations/:id                organization:read:organization
GET  /organizations/:id/members        organization-member:read:organization
+ the products router, reached via product:*:organization
```

Send `X-Organization-Id` unless the caller belongs to exactly one organization.

## Related

- [01 — Architecture](01-architecture.md)
- [10 — Frontend integration](10-frontend-integration.md)
- [09 — Security](09-security.md)
