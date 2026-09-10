# HitBox Authorization Architecture

> How the platform decides ALLOW or DENY: the two authorization domains, the permission catalog,
> the engine, and the rules that keep a deploy key from issuing refunds.
>
> Companion reading: [hitbox-architecture.md](../hitbox-architecture.md) (module layering, ports,
> events), [database-architecture.md](../database-architecture.md) (schema ownership).

---

## 1. The core idea

**Roles say who someone is allowed to be. Permissions say what they can do. APIs are resources.
Authorization connects the three.**

```text
                        AUTHORIZATION
                              │
              ┌───────────────┴───────────────┐
              │                               │
          BUSINESS                        TECHNICAL
    10 roles, 74 permissions        2 roles, 12 permissions
    drops, orders, money,           releases, logs, nodes,
    buyers, content, audit          app + platform config
              │                               │
              └───────────────┬───────────────┘
                              ▼
                    AUTHORIZATION ENGINE
              principal + capability + context
                              ▼
                       ALLOW / DENY
                    (+ granted visibility)
```

Two rules do most of the work:

1. **A route names a capability, never a role.** `requirePermission('order:refund')`, never
   `if (user.role === 'HITBOX_ORDER_MANAGER')`. There are no `/content-manager/*` or
   `/finance-admin/*` namespaces, and there never should be — `POST /api/v1/content` is one
   endpoint that any role holding `content-unlock:create` can call.
2. **A role holds permissions from exactly one domain.** Enforced in three places (see §4), not
   just documented.

---

## 2. What exists today

| Piece | Where | Count |
|---|---|---|
| Permission catalog | `packages/access-control/src/domain/permission-catalog.ts` | 86 permissions |
| Role catalog | `packages/access-control/src/domain/role-catalog.ts` | 12 roles |
| Engine | `packages/access-control/src/engine/authorization-engine.ts` | 1 pure function |
| Guard | `packages/access-control/src/middleware/require-permission.middleware.ts` | `requirePermission` / `authorize` |
| Grant cache | `packages/access-control/src/cache/` | 3 layers + per-request memo |
| Admin API | `/api/v1/admin/authz/*` | 9 endpoints |
| Self API | `/api/v1/authz/me` | 1 endpoint |
| Tests | `packages/access-control/tests/` | 265 across 7 suites |

Seeded into Neon by `pnpm db:seed:authz`: **86 permissions** (74 BUSINESS + 12 TECHNICAL),
**12 system roles**, **119 role-permission grants**, **0 cross-domain grants**.

---

## 3. The authorization model

### 3.1 A permission is `resource:action:scope`

```text
order:refund:global            drop:manage:organization        order:read:own
  │      │       │
  │      │       └─ PermissionScope   — how far it reaches
  │      └───────── PermissionAction  — the verb
  └──────────────── ResourceType      — the protected surface
```

All three segments are kebab-cased enum values, so a typo in a route guard fails at parse time
rather than silently never matching. `packages/access-control/src/domain/permission-key.ts` is the
only (de)serialiser; it also accepts two aliases the requirements matrix uses — `:any` for
`:global` and `:org` for `:organization`.

### 3.2 Scope carries two axes at once

This is the part worth understanding. A `PermissionScope` encodes **breadth** (whose records) and
**visibility** (how much of each record):

| Scope | Breadth | Visibility | Example holder |
|---|---|---|---|
| `GLOBAL` | all records | full | HitBox System Admin |
| `ORGANIZATION` | one organization | full | Brand Admin |
| `OWN` | the actor's own records | full | Buyer |
| `MASKED_PARTIAL` | all records | partially redacted | HitBox Order Manager |
| `MASKED` | all records | fully redacted | HitBox Support |
| `PUBLIC` | all records | public fields only | Buyer browsing drops |

Why it matters: `buyer-profile:read` is **one capability at three visibilities**. Support sees
`j***@***.com`, the Order Manager sees a partial mask, the System Admin sees the real value — and
they all call the same endpoint. The engine returns which scope was satisfied, so the controller
masks from `req.authz.visibility` instead of re-deriving it from a role name.

Precise GPS is deliberately not expressible: `general-location:read:masked` exists,
`general-location:read:global` does not, for any role.

### 3.3 The one sanctioned implication

`MANAGE` expands to `CREATE + READ + UPDATE + DELETE` — within one resource and one scope only.
That is what lets Brand Admin hold `drop:manage:organization` without also listing `drop:read`.

It is **not** role inheritance (§15 of the brief): no role gains another role's permissions, and
`MANAGE` does not imply `REFUND`, `APPROVE`, `OVERRIDE`, `EXPORT` or `PUBLISH`. Those stay
explicit because they are the dangerous ones.

### 3.4 Multiple roles, unioned

A user holds any number of `RoleAssignment` rows, and their effective permissions are the union:

```text
User
├── ARTIST                      (organization-scoped, own artist records)
├── BRAND_EMPLOYEE @ Brand A    (organization-scoped to Brand A only)
└── HITBOX_FULL_STACK_ENGINEER  (global, technical domain)
```

No combined roles (`ARTIST_AND_BRAND_EMPLOYEE`) and no implicit inheritance. Each assignment keeps
its own scope, so the Brand A assignment above grants nothing in Brand B.

---

## 4. The business ↔ technical boundary

`AuthorizationDomain` is `BUSINESS | TECHNICAL`, and it sits on **both** `Role` and `Permission`.
A role may only hold permissions of its own domain.

### Which resources are which

The line is **"operating the product" vs "operating the software"**:

| Domain | Resources |
|---|---|
| **BUSINESS** (20) | `SELF_PROFILE`, `BUYER_PROFILE`, `DROP`, `RELEASE_APPROVAL`, `COLLECTIBLE_INSTANCE`, `REPORTS_DASHBOARDS`, `MY_COLLECTIONS`, `ORDER`, `PAYMENT_ROYALTY`, `CONTENT_UNLOCK`, `NFC_TAG_CLAIM`, `BRAND_ARTIST_RECORD`, `EMPLOYEE_ROLE_MGMT`, `AUDIT_LOG`, `NOTIFICATION_CONFIG`, `SEARCH_DISCOVER`, `ASSETS_DOCUMENTS_UPLOAD`, `GENERAL_LOCATION`, `AGE_SPECIFIC_FLAG`, `ADDRESS` |
| **TECHNICAL** (4) | `APPLICATION`, `INFRASTRUCTURE`, `OPS_DASHBOARD_INFRA`, `PLATFORM_CONFIG` |

### Enforced in three places, not one

Documentation does not stop a bad grant. This does:

1. **Import time** — `role-catalog.ts` asserts every role's permissions are same-domain and throws
   on load. A bad edit crashes the process at boot, not at 3am in a permission check.
2. **Write time** — `RoleService.resolvePermissions` rejects a cross-domain selection with
   `AUTHZ_DOMAIN_VIOLATION` (400), naming the offending keys. This covers roles created through the
   admin API, which the code catalog cannot see.
3. **Read time** — grants carry their permission's domain, so a leak is visible in
   `GET /authz/me` and provable by query. The database currently reports **0** cross-domain grants.

### The consequence worth knowing

**`HITBOX_SYSTEM_ADMIN` holds no technical permissions.** It is a BUSINESS role, so it does not
carry `platform-config:configure` or `ops-dashboard-infra:read`, even though the requirements
matrix listed them — the matrix itself flagged those as *"recorded for audit visibility, not
app-enforced"*, so nothing enforced is lost.

This is the same rule that stops `BRAND_ADMIN` from deploying infrastructure, applied
consistently. Someone who genuinely needs both sides holds **two role assignments**, which is
visible and revocable, rather than one role that quietly spans both.

There is no break-glass bypass. The prior codebase had no `SUPER_ADMIN` mechanism to preserve, so
every System Admin capability is an explicit permission and the engine has no role-name special
case anywhere in it.

---

## 5. The roles

### Business — end user

| Role | Scope | Holds |
|---|---|---|
| `BUYER_COLLECTOR` | OWN | 13 — own profile, collection, orders, addresses, claim by tap, plus public browse/search |

Role administration is absent by design: a buyer hitting an authz route gets a 403, never a
filtered empty 200.

### Business — brand / artist (organization-scoped)

| Role | Holds | Notes |
|---|---|---|
| `BRAND_ADMIN` | 15 | Approval authority, brand revenue, royalties owed, artist profiles, org settings, role assignment within own org |
| `BRAND_EMPLOYEE` | 8 | Same drop/content authoring; **no** approval, **no** money, **no** org settings, **cannot** assign roles |
| `ARTIST` | 12 | Can approve like a Brand Admin, but revenue and royalties are `:own`, not `:organization` |

The Brand Admin ↔ Brand Employee difference is exactly seven permissions, asserted as a test.

### Business — HitBox staff (platform-wide)

| Role | Holds | Notes |
|---|---|---|
| `HITBOX_SYSTEM_ADMIN` | 29 | Highest business privilege; only role that can create roles or grant globally |
| `HITBOX_DROP_MANAGER` | 7 | Any brand's drops, nothing outside drops |
| `HITBOX_CONTENT_MANAGER` | 6 | Exclusive content; age flag **masked** |
| `HITBOX_ORDER_MANAGER` | 5 | Any order; buyer PII **partially masked** |
| `HITBOX_FINANCE_ADMIN` | 3 | Reads finance; **cannot** configure gateways or touch the royalty ledger |
| `HITBOX_SUPPORT` | 5 | Buyer PII **fully masked**, no unmask path |

### Technical — platform engineering

| Role | Holds | Notes |
|---|---|---|
| `HITBOX_PLATFORM_ENGINEER` | 11 | Deploy, debug, restart, configure app + infrastructure |
| `HITBOX_FULL_STACK_ENGINEER` | 5 | Read and diagnose only — cannot deploy or configure |

Neither can read an order, issue a refund, see a financial report or suspend a user, and stacking
them produces no business capability. `HITBOX_FULL_STACK_ENGINEER` shares **zero** capabilities
with `HITBOX_SYSTEM_ADMIN`.

**`HITBOX_DB_ADMIN` is deliberately absent.** Database administration belongs to cloud/IAM grants,
not to this application's authorization system.

---

## 6. Authorization flow

```text
1. requireAuth (@hitbox/auth)
      verifies the Clerk JWT, attaches req.auth = { accountId, … }

2. requirePermission('order:refund')          ← the route names a CAPABILITY
      resolvePrincipalId(req)  ──▶ accountId        (no principal ⇒ 401, a wiring bug)
      findGrantsByUserId(accountId)             <- L1 -> L2 -> Postgres (see §7)
          RoleAssignment (revokedAt: null)
            → Role       (isActive)
              → RolePermission
                → Permission (isActive)
          ⇒ PrincipalGrant[]                       memoised per request (WeakMap)

3. decide(principal, { resource, action, context })   ← pure, no I/O
      a. candidates = grants matching resource, action (MANAGE expands)
         none ⇒ DENY "no grant for order:refund"
      b. for each candidate, does its BREADTH reach the record?
         ALL          → assignment must not be org-scoped
         ORGANIZATION → assignment org must equal record org
         SELF         → record owner must equal actor
         none reach ⇒ DENY "holds order:refund but out of scope — …"
      c. among those that reach, pick the greatest VISIBILITY
         FULL > PARTIAL > MASKED > PUBLIC

4. ALLOW ⇒ req.authz = { scope, visibility, roleName, organizationId, fieldAllowlist }
   DENY  ⇒ AppError.forbidden(AUTHZ_FORBIDDEN) → 403 via the shared error boundary

5. Controller shapes its response from req.authz.visibility.
```

Two denial reasons are kept distinct on purpose: *"no grant"* (never held the capability) and
*"out of scope"* (held it, wrong record) are different events in an audit review.

### Guarding a row, not just a route

The middleware guards the route from what the request carries. Once a service has loaded the
record and knows its real owner and organization, re-check:

```ts
// route
router.post('/:id/refund', requireAuth, requirePermission('order:refund'), controller.refund);

// service, after loading the order
await guard.authorize(req, 'order:refund', {
    organizationId: order.organizationId,
    ownerId: order.buyerId,
});
```

The principal is loaded once per request, so the second check costs nothing.

---

## 7. Grant caching

Loading a principal's grants means a four-table join
(`RoleAssignment -> Role -> RolePermission -> Permission`) and it happens on **every** permission
check. Three layers sit in front of it, plus a per-request memo:

```text
   L0  per-request WeakMap     several checks in one request -> one lookup
        |  miss
        v
   L1  in-process Map          zero network. TTL 15 s, LRU-bounded to 5k users
        |  miss
        v
   L2  Redis                   shared by every instance. TTL 60 s
        |  miss                key: authz:grants:{epoch}:{userId}
        v
   L3  PostgreSQL              source of truth. Never bypassed on a miss.
```

A read walks down until something answers, then **back-fills upward** — so an instance with a cold
L1 but a warm L2 costs one Redis `GET` instead of the join. Measured against the real stack: first
read = 1 Postgres query; second read = 0; a second instance sharing Redis = 0 Postgres queries.

The cache is a **decorator** around `RoleAssignmentRepository`, not logic inside it. The repository
stays a pure Postgres reader, and the engine receives an `IPrincipalGrantsLookup` either way and
never learns which one it got. `createAccessControlModule({ cache: false })` reads straight from
Postgres — useful in tests and when debugging a decision without cache interference.

### Why this needs more care than caching a product listing

A stale product listing is a cosmetic bug. **A stale grant is a revoked administrator who still
has access.** So the design is invalidation-first, with TTLs only as a backstop:

| Trigger | Action | Cost |
|---|---|---|
| Role assigned / revoked | `invalidateUser` — evict L1, `DEL` the L2 key, broadcast | O(1), precise |
| Role's permissions edited, role deactivated or deleted | `invalidateAll` — clear L1, `INCR` the epoch, broadcast | O(1), blunt |
| Permission catalog re-synced (if anything changed) | `invalidateAll` | O(1) |

Four mechanisms make that hold up in practice:

1. **Invalidation is awaited before the response.** `RoleAssignmentService` awaits
   `invalidateUser` *before* returning, so a revoke is effective by the time the caller sees its
   `204` — not one TTL later. This is why invalidation is an injected port
   (`IGrantsInvalidator`) rather than an event-bus subscriber: the in-process bus dispatches on
   `setImmediate`, which would land after the response.

2. **An epoch counter replaces `SCAN`.** Editing a role changes what an unknown set of users may
   do. Finding them means querying every assignment; instead a counter in the L2 key namespace is
   `INCR`'d, and every cached entry everywhere becomes unreachable in one command. The orphaned
   keys expire on their own TTL — no `SCAN`, which blocks a production Redis, and no `DEL` storm.

3. **Pub/sub evicts L1 across instances.** L1 lives inside a process, so Redis alone cannot reach
   it. Every invalidation is published on `authz:grants:invalidate`; each instance subscribes on a
   dedicated connection (a Redis connection in subscriber mode cannot run normal commands) and
   clears the affected entry within milliseconds. A publisher ignores the echo of its own message,
   having already applied it locally.

4. **A failed eviction stops trusting L2.** Pub/sub is at-most-once and a `DEL` can fail. If the
   distributed half of an invalidation does not land, a stale entry may still be sitting in Redis
   — so that instance **bypasses L2 for one L2 TTL** rather than serving it back. The L2 TTL is
   deliberately 60 s, not 5 minutes, because it is the blast radius of exactly this case.

### Failure behaviour

Every layer fails to **the layer below**, never to "allow":

| Condition | Behaviour |
|---|---|
| `REDIS_URL` unset | L1 + Postgres only. Logged once at boot. Staleness bounded by the 15 s L1 TTL. |
| Redis read throws | Falls through to Postgres. Warned; request succeeds with correct data. |
| Redis write throws | Cache skipped. Request succeeds. |
| Invalidation throws | L1 already evicted locally; L2 distrusted for one TTL; logged at `error`. The mutating request still succeeds — the database, the source of truth, was already written. |
| Pub/sub message missed | That instance's L1 self-expires within 15 s. |

There is no configuration in which a cache failure grants access that Postgres would deny.

### Worst-case staleness

| Scenario | Window |
|---|---|
| Normal revoke (Redis healthy) | Effective immediately on every instance |
| Broadcast missed by one instance | <= 15 s (L1 TTL) on that instance |
| Redis `DEL` failed during revoke | <= 15 s locally; <= 60 s on instances that had it cached |
| Redis entirely down | <= 15 s |

Note this is staleness of *cached grants*, not of the Clerk session — revoking a role does not
invalidate a session, it removes what that session may do (see §13, open item 5).

### Operating it

`module.cacheStats()` returns per-layer counters — L1 hits/misses/evictions/expirations, L2
hits/misses, source loads, current epoch, whether L2 is trusted, whether Redis is available, and
whether the subscriber is live. Worth surfacing on an ops dashboard: a collapsing L1 hit rate
means the TTL is too short for the traffic shape, and `l2Trusted: false` means invalidations are
failing.

Tunables live in `constants/access-control.constant.ts`
(`AUTHZ_CACHE_L1_TTL_MS`, `AUTHZ_CACHE_L1_MAX_ENTRIES`, `AUTHZ_CACHE_L2_TTL_SECONDS`) and can be
overridden per instance via `createAccessControlModule({ cache: { ... } })`.

`bootstrap()` exposes `startCaches()` / `stopCaches()`, called from `server.ts` on boot and on
`SIGINT`/`SIGTERM`. Skipping `startCaches()` is safe — caching still works, instances just learn
about each other's invalidations via TTL rather than broadcast.

---

## 8. APIs

One generic set of endpoints for all authorization administration — no screen or route per role.

| Method | Path | Capability required |
|---|---|---|
| `GET` | `/api/v1/authz/me` | authenticated only (own grants) |
| `GET` | `/api/v1/admin/authz/permissions` | `employee-role-mgmt:read` |
| `GET` | `/api/v1/admin/authz/roles` | `employee-role-mgmt:read` |
| `GET` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:read` |
| `POST` | `/api/v1/admin/authz/roles` | `employee-role-mgmt:manage` |
| `PATCH` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:manage` |
| `DELETE` | `/api/v1/admin/authz/roles/:roleId` | `employee-role-mgmt:manage` |
| `GET` | `/api/v1/admin/authz/users/:userId/roles` | `employee-role-mgmt:read` |
| `POST` | `/api/v1/admin/authz/users/:userId/roles` | `employee-role-mgmt:assign` |
| `DELETE` | `/api/v1/admin/authz/users/:userId/roles/:roleId` | `employee-role-mgmt:delete` |

Defining roles takes `manage`; granting them takes `assign` — defining is strictly stronger.
A Brand Admin holds `employee-role-mgmt:assign:organization`, so the same POST endpoint lets them
grant only inside their own organization, while a System Admin's `:global` grant reaches anywhere.

### Admin panel support

`GET /admin/authz/permissions?shape=grouped` (the default) returns the catalog grouped by resource
with human labels, so the UI renders selectable trees rather than raw strings:

```text
Orders                          Application
 ├── Read      (own)             ├── Read      (platform-wide)
 ├── Read      (platform-wide)   ├── Debug     (platform-wide)
 ├── Manage    (platform-wide)   ├── Deploy    (platform-wide)
 ├── Refund    (platform-wide)   └── Configure (platform-wide)
 └── Override  (platform-wide)
```

Add `?domain=TECHNICAL` to filter. The backend translates the selection into permission
identifiers; the client never constructs one.

### Permissions are system-defined

An administrator picks from the catalog and cannot type a permission string. The create/update DTO
validates every key against the catalog, so `delete-everything`, `my-custom-permission`,
`order:*:global` and `*` are all rejected with a 422. No wildcards are supported anywhere — the
prior system had none to preserve.

---

## 9. Database changes

Migration `20260910101500_add_authorization_domain_and_scopes`, applied to Neon.

**Additive:**

| Change | Detail |
|---|---|
| New enum `AuthorizationDomain` | `BUSINESS \| TECHNICAL` |
| `Role.domain` | `AuthorizationDomain`, required |
| `Role.isSystem` | `Boolean`, required — protects catalog-seeded roles |
| `Permission.domain` | `AuthorizationDomain`, required; derived from the resource |
| `PermissionAction` +3 | `DEBUG`, `DEPLOY`, `RESTART` |
| `ResourceType` +2 | `APPLICATION`, `INFRASTRUCTURE` |
| `PermissionScope` +3 | `PUBLIC`, `MASKED`, `MASKED_PARTIAL` |

**Renames** (`ORG` → `ORGANIZATION` in `PermissionScope` and `RoleScopeType`) so both enums, the
permission-key strings, the requirements matrix and the `ScopeKind` type all use one word. Safe
here because the four RBAC tables were empty; on a populated database this needs a data migration.

**Reused unchanged:** `Role`, `Permission`, `RolePermission` (including its existing
`fieldAllowlist`), `RoleAssignment` (including `scopeType` / `scopeId` / `revokedAt`). No table was
created, dropped or duplicated — the technical domain rides the same four tables as the business
domain, with `domain` providing the boundary.

`User.role` (`UserRole`, single member `USER`) is untouched and still means only "this account
exists". Every real privilege is a `RoleAssignment`.

---

## 10. Seeding

```bash
pnpm db:seed:authz
```

Idempotent — safe on every deploy. The code catalog is the authority, so re-running reconciles
database drift back to it. Operator-defined roles (`isSystem = false`) are never touched.
Retired permissions are **deactivated**, not deleted, because `role_permissions` rows reference
them and the grant history should stay readable.

**It creates no role assignments.** Bootstrapping the first administrator is a one-off operational
act, not something a seed should do silently on every deploy. To grant the first System Admin,
insert one `role_assignment` row directly:

```sql
INSERT INTO "RoleAssignment" (id, "userId", "roleId", "scopeType", "scopeId", "grantedById", "grantedAt")
SELECT gen_random_uuid(), :user_id, r.id, 'GLOBAL', NULL, :user_id, now()
FROM "Role" r WHERE r.name = 'HITBOX_SYSTEM_ADMIN';
```

After that, every further grant goes through the API and is attributed and revocable.

---

## 11. Tests

228 tests, 6 suites, in `packages/access-control/tests/`. They build principals from the **real**
catalogs and run the **real** engine, so a test cannot drift from the thing it checks — editing a
role's permissions changes what the tests see.

| Suite | Covers |
|---|---|
| `domain-isolation.test.ts` | The §5 boundary: technical roles cannot refund/read orders/read finance/read PII/assign roles; business roles cannot deploy/configure/debug/restart; System Admin is not a technical bypass; stacking never crosses domains |
| `role-catalog.test.ts` | Each of the 12 roles holds **exactly** its intended permission set (exact sets, not `toContain`); `HITBOX_DB_ADMIN` absent; the Brand Admin ↔ Employee delta; Support vs Order Manager masking; Finance Admin's withheld capabilities |
| `authorization-engine.test.ts` | Default deny; MANAGE expansion and its limits; organization isolation both ways; own-record scoping; visibility precedence; multi-role union without escalation; field allowlist passthrough |
| `require-permission.test.ts` | 403 on missing capability, 401 on missing principal, boot-time throw on a malformed guard, per-request principal memoisation, `authorize()` after load, `/authz/me` shape |
| `permission-catalog.test.ts` | Catalog integrity, canonical keys, unique triples, scope decomposition, key parsing and aliases, §12 grouping, and that invented permission strings are rejected |
| `role.service.test.ts` | Cross-domain writes rejected both directions; system roles immutable and undeletable; delete blocked while assigned; assignment scope defaults and duplicate/revoke handling; that assign/revoke evict precisely and role edits flush, while rejected writes evict nothing |
| `grants-cache.test.ts` | L1 TTL expiry and LRU bounding; the L1->L2->source walk and upward back-fill; per-user keying; empty-grant caching; precise vs. epoch invalidation; pub/sub eviction across instances and self-echo suppression; degradation with no Redis, on read failure, and on failed eviction (including the L2 distrust window) |

The isolation suite is table-driven over every role, so a newly added role is automatically
checked against both forbidden lists.

---

## 12. Adding to the system

**Guard a new endpoint** — name the capability, never the role:

```ts
router.post('/', requireAuth, requirePermission('content-unlock:create'), controller.create);
```

**Add a permission:** add the key to `DEFINITIONS` in `permission-catalog.ts`, then
`pnpm db:seed:authz`. The domain is derived from the resource — you do not choose it.

**Add a resource or action:** add the enum value to
`packages/access-control/prisma/access-control.prisma`, classify it in `RESOURCE_DOMAIN`, give it a
`RESOURCE_DISPLAY` label, then `pnpm db:migrate`. The `Record<>` types make an unclassified
resource a compile error.

**Add a role:** add a `RoleDefinition` to `ROLE_CATALOG` and re-seed — or create it through
`POST /admin/authz/roles` if it is operator-specific rather than part of the platform's floor.

---

## 13. Decisions and open questions

### Decisions

1. **Reused the existing `ResourceType` vocabulary for business resources**, rather than adding
   `PRODUCT`/`CONTENT`/`REFUND` alongside `DROP`/`CONTENT_UNLOCK`/`ORDER`. Two names for one
   concept is the duplication the brief warns against. So `POST /api/v1/products` is guarded by
   `drop:create:organization`, and refunds by `order:refund`. **Confirmed with the user before
   implementing.**
2. **Added `APPLICATION` and `INFRASTRUCTURE`** as new technical resources. Neither
   `OPS_DASHBOARD_INFRA` (a dashboard) nor `PLATFORM_CONFIG` (feature flags) is a natural home for
   deploy/debug/restart, and the brief named these two explicitly. **Confirmed with the user.**
3. **Encoded masking in `PermissionScope`** rather than a separate column, keeping one permission
   identity per capability and letting the engine return the granted visibility. **Confirmed with
   the user.**
4. **`domain` on `Permission` as well as `Role`.** The brief only asked for `role.domain`, but with
   it on the role alone nothing stops a seed or an admin from putting
   `infrastructure:deploy:global` on `BRAND_ADMIN`. On both, the invariant is checkable and checked.
5. **Domain is immutable after creation.** `PATCH /roles/:roleId` deliberately omits it — flipping
   a role's domain would silently re-authorise everyone already holding it. Retire and recreate.
6. **System roles are protected.** `isSystem = true` blocks permission edits and deletion through
   the API (deactivation is still allowed), because the catalog is the authority and deleting
   `HITBOX_SYSTEM_ADMIN` would lock everyone out.
7. **A role in use cannot be deleted.** Deleting it would revoke access as a side effect with no
   assignment record left to explain why; revoke the assignments first.
8. **Revocation is soft.** `revokedAt` is set and the row stays, so the trail can answer "who held
   what in March" — a hard delete would erase exactly the evidence a review needs.
9. **No `@hitbox/auth` dependency.** The guard reads the account id through an injected
   `resolvePrincipalId` port, wired in `bootstrap.ts`. Access control knows nothing about Clerk, so
   swapping the identity provider never touches authorization.

### Assumptions

- **`HITBOX_FULL_STACK_ENGINEER` is in scope.** The requirements matrix marked it `[DECISION
  NEEDED]`/proposed; the brief said to support it, so it is seeded as a system role. Its permission
  set is the conservative read-and-diagnose reading — no deploy, no configure.
- **`PermissionScope.GLOBAL`/`MASKED`/`MASKED_PARTIAL` are the intended masking levels** for
  D4-6/7/8. `general-location` tops out at `masked` for every role, including System Admin.
- **Permissions marked "inferred" in the matrix are treated as confirmed** where a role obviously
  needs them to function (e.g. Content Manager needing `drop:read:global` for context). They are
  commented as such in `role-catalog.ts`.
- **`entityGroup` stays free-text** (`end_user` / `brand_artist` / `hitbox_seller_org`), validated
  by the DTO enum rather than a database enum, matching the existing column.

### Open

1. **Masking is decided but not applied.** The engine returns `req.authz.visibility`; no controller
   consumes it yet, because the business modules that would (buyer profile, orders) still target
   the pre-decomposition schema. A shared `maskBuyerProfile(record, visibility)` helper belongs in
   `@hitbox/shared` when the first consumer appears.
2. **No `expiresAt` on assignments.** The brief said "set expiration if supported" — it is not.
   `RoleAssignment` has `revokedAt` only. Adding a nullable `expiresAt` plus one clause in
   `findGrantsByUserId` would cover it.
3. **No audit rows written yet.** Role create/update/delete/assign/revoke publish events on the
   bus and log structured lines, but nothing subscribes to write `AuditEvent`. The audit module
   owns those tables; wiring a subscriber is a small, separate change.
4. **Cache tuning is unmeasured.** The three-layer cache is in place (§7), but its TTLs
   (15 s L1 / 60 s L2) are chosen for safety rather than from observed traffic — watch
   `cacheStats()` under load and adjust. One case is knowingly unaddressed: a cold multi-instance
   deployment can stampede, since N instances missing the same key all query Postgres. A per-key
   in-flight promise map would coalesce them; not worth the complexity until the traffic exists.
5. **Session invalidation on revoke is unresolved.** Revoking a role takes effect on the next
   request, since grants are read per request — but a Clerk session itself is not invalidated. That
   is the intended behaviour here; confirm it is acceptable.
6. **`EMPLOYEE_ROLE_MGMT` scope check on assignment is body-derived.** The guard compares the
   `organizationId` in the request body against the assigner's own organization. A Brand Admin
   therefore cannot grant outside their org — but the *target user's* existing memberships are not
   validated. Worth revisiting if brands ever share users.
7. **The rest of the application is still pre-decomposition.** `products`, `users`, `claims`,
   `artist` and `collections` target the old schema (214 type errors) and mount no permission
   guards yet. `@hitbox/access-control` and `@hitbox/auth` both typecheck clean, and the guard is
   wired in `bootstrap.ts`, so guarding those routes is a per-module change once each module is
   brought onto the new schema.
