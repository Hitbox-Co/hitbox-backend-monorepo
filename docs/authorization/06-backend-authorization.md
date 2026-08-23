# 06 — Backend authorization

The backend is the final authority. Every request is re-checked against live
database state, regardless of what any client believes.

## The two checks

They answer different questions and run at different times.

| | Permission check | Policy check |
|---|---|---|
| Question | "May you update products?" | "May you update *this* product?" |
| Needs | the principal | the principal **and the row** |
| Cost | none (in-memory over cached grants) | one narrow query |
| Rejects | 403 `AUTHZ_PERMISSION_DENIED` | 403 `AUTHZ_RESOURCE_FORBIDDEN` |

Both are usually required. A permission check alone lets an artist with
`product:update:own` edit anybody's product. A policy check alone means loading
rows for callers who were never going to be allowed.

The distinct error codes are operationally useful: `PERMISSION_DENIED` in bulk
usually means a role is misconfigured; `RESOURCE_FORBIDDEN` in bulk means someone
is reaching for data that is not theirs.

## The route guard

`requirePermission` is the only thing a feature module needs to know about
authorization. It is created once in the composition root and injected.

```ts
router.post('/products',
    requireAuth,
    requirePermission('product', 'create'),
    controller.create);

router.patch('/products/:id',
    requireAuth,
    requirePermission('product', 'update', {
        resource: (req) => service.refFor(req.params.id as string),
    }),
    controller.update);
```

What it does, in order:

1. loads the principal (L1 → L2 → Postgres) and resolves the tenant context
2. **permission check** — capability held in this context? else 403
3. **step-up gate** — if the catalog marks this capability sensitive
4. **policy check** — if `resource` is given, load the row's owner/tenant;
   404 when the row is missing, 403 when it is not theirs
5. audits every denial, and every success on a sensitive capability

Any unexpected state — no `req.auth`, a throwing loader, an unknown scope —
results in a rejection. There is no path that falls open.

### Options

| Option | Effect |
|---|---|
| `resource: (req) => ResourceRef \| null` | run the policy check; `null` → 404 |
| `requireOrganization: true` | 400 `AUTHZ_ORGANIZATION_REQUIRED` if no tenant resolved |
| `audit: true` | audit successes too (sensitive ones are audited anyway) |
| `skipStepUp: '<reason>'` | bypass step-up; requires a written reason so it surfaces in review |

### Why 404 and not 403 for a missing row

```ts
requirePermission('product', 'update', { resource: (req) => service.refFor(req.params.id) })
// row does not exist → 404
```

If a missing row returned 403, the difference between 403 and 404 would tell an
attacker which product ids exist. Returning 404 leaks nothing about either
existence or entitlement.

## Doing it in a service instead

When the check depends on business state the router cannot see, use the service
directly. Same functions, same semantics.

```ts
import type { AuthorizationService } from '@hitbox/authz';

async function refundOrder(authz: AuthorizationService, principal: AuthzPrincipal, orderId: string, organizationId: string | null) {
    const order = await orders.findById(orderId);
    if (!order) throw AppError.notFound('Order not found');

    const request = { resource: 'order', action: 'refund', organizationId } as const;

    // Both halves in one call.
    authz.authorize(principal, request, {
        ownerId: order.userId,
        organizationId: order.organizationId,
    });

    // ... and a business rule, which is NOT an authorization concern
    if (order.status !== 'PAID') throw AppError.badRequest('Order is not refundable');

    return orders.refund(orderId);
}
```

The full service API:

| Method | Purpose |
|---|---|
| `getPrincipal(userId, { fresh? })` | cache-through load of the snapshot |
| `hasPermission(principal, request)` | boolean capability check |
| `requirePermission(principal, request)` | throws 403 if absent |
| `hasPermissionAtScope(principal, request, scope)` | "at least this wide?" |
| `canAccessResource(principal, request, ref)` | boolean policy check |
| `requireResourceAccess(principal, request, ref)` | throws 403 if refused |
| `authorize(principal, request, ref)` | both, in order |
| `requiresStepUp(principal, request)` | is this capability sensitive? |
| `describe(principal)` | the frontend manifest |
| `invalidate(userId)` / `invalidateEverything()` | cache invalidation |

### `fresh: true`

Role administration reads the actor's principal with `fresh: true`, bypassing both
cache tiers. A few seconds of staleness is fine for reading a product; it is not
fine when the actor's own authority may have just been revoked and they are about
to grant somebody else a role.

## Exposing a resource for policy checks

The module that owns a resource exposes ownership and tenancy, and does **not**
import `@hitbox/authz` to do it:

```ts
// packages/products/src/repository/product.repository.ts
findAuthorizationRef(id: string) {
    return this.prisma.product.findUnique({
        where: { id },
        select: { ownerId: true, organizationId: true },   // two columns, nothing else
    });
}
```

The returned shape structurally satisfies `ResourceRef`, so the catalog module
stays independent of the authorization module.

## List endpoints

Do not check-then-filter. Translate grants into the query — see
[04 — Scopes & tenancy](04-scopes-and-tenancy.md#list-endpoints).

```ts
const filter = buildScopeFilter(principal, { resource: 'product', action: 'read', organizationId });
const where  = scopeWhere(filter, { ownerField: 'ownerId', organizationField: 'organizationId' });
if (where === null) return emptyPage();
```

## Worked examples

### 1. An artist edits their own product — allowed

```http
PATCH /api/v1/products/prod_123
Authorization: Bearer <clerk token>
```

```text
requireAuth              → req.auth.accountId = user_ayan
load principal           → USER + ARTIST grants (cached)
tenant context           → null (no header, no membership)
permission check         → product:update:own applies                  ✅
step-up                  → product:update:own is not sensitive         skip
policy check             → refFor(prod_123) = { ownerId: user_ayan, organizationId: null }
                           own-scope: ownerId === principal.userId      ✅
→ 200
```

### 2. The same artist edits someone else's product — denied

```text
permission check         → product:update:own applies                  ✅
policy check             → { ownerId: user_priya, organizationId: null }
                           own-scope: mismatch                         ❌
→ 403  AUTHZ_RESOURCE_FORBIDDEN
   audit: DENIED, reason "resource policy denied"
```

Note the capability check *passed*. Only the row-level check stopped it — which
is precisely why both exist.

### 3. A product manager edits a product in their tenant — allowed

```http
PATCH /api/v1/manage/products/prod_777
X-Organization-Id: org_acme
```

```text
tenant context           → org_acme (active member)
permission check         → product:update:organization @ org_acme       ✅
policy check             → { ownerId: null, organizationId: org_acme }
                           org-scope: grant.org === row.org             ✅
→ 200
```

### 4. …and a product in a different tenant — denied

```text
tenant context           → org_acme
permission check         → product:update:organization @ org_acme       ✅
policy check             → { organizationId: org_vinyl }
                           org-scope: org_acme ≠ org_vinyl              ❌
→ 403  AUTHZ_RESOURCE_FORBIDDEN
```

Even forcing `X-Organization-Id: org_vinyl` fails: the caller has no ACTIVE
membership there, so context resolution returns 403 first.

### 5. A finance manager refunds an order — step-up required

```http
POST /api/v1/manage/orders/ord_9/refund
X-Organization-Id: org_acme
```

```text
permission check         → order:refund:organization @ org_acme         ✅
step-up                  → order:refund is sensitive; fva = [92, -1]
                           92 min > AUTHZ_STEP_UP_MAX_AGE_MINUTES (15)  ❌
→ 403  AUTHZ_STEP_UP_REQUIRED
   audit: DENIED, reason "step-up verification required"
```

The client runs Clerk re-verification and retries; `fva` is now `[0, -1]` and the
call proceeds, with a `SUCCESS` audit row.

### 6. A support agent tries to process a refund — denied

```text
permission check         → SUPPORT_AGENT holds refund:request:organization,
                           NOT refund:process                           ❌
→ 403  AUTHZ_PERMISSION_DENIED
```

Separation of duties, expressed as two distinct actions rather than as a code
branch.

### 7. An org admin appoints a product manager — allowed

```http
POST /api/v1/admin/authz/users/user_bob/roles
X-Organization-Id: org_acme
{ "roleKey": "PRODUCT_MANAGER" }
```

```text
permission check         → role:assign:organization @ org_acme          ✅
step-up                  → role:assign is sensitive; fva fresh          ✅
gate: role exists, target exists, not self                              ✅
gate: kind matches context (ORGANIZATION + org_acme)                    ✅
gate: actor may grant in THIS tenant                                    ✅
gate: no escalation — role carries no platform-wide mutating permission ✅
→ 201, target's cache invalidated, durable audit row written
```

### 8. …and tries to mint a platform admin — denied

```text
POST /api/v1/admin/authz/users/user_bob/roles   { "roleKey": "PLATFORM_ADMIN" }

gate: PLATFORM_ADMIN is privileged → requires role:assign:any
      ORG_ADMIN holds only role:assign:organization                     ❌
→ 403  AUTHZ_ESCALATION_BLOCKED
```

This is the concrete mechanism behind "an organization administrator does not
become a platform administrator". See [09 — Security](09-security.md).

### 9. Anonymous read of the public catalog — allowed

```text
GET /api/v1/products/prod_123     (no token)
→ 200
```

Public routes carry no guard at all. They live on the public surface and must
expose nothing that is not already public.

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `AUTH_UNAUTHENTICATED` | 401 | no token |
| `AUTH_INVALID_TOKEN` | 401 | bad/expired token |
| `AUTH_ACCOUNT_NOT_FOUND` | 401 | no local account, or deleted |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | account suspended |
| `AUTH_EMAIL_UNVERIFIED` | 403 | synced email not verified |
| `AUTHZ_MISSING_AUTH_CONTEXT` | 401 | `requirePermission` without `requireAuth` — a wiring bug |
| `AUTHZ_PERMISSION_DENIED` | 403 | capability not granted |
| `AUTHZ_RESOURCE_FORBIDDEN` | 403 | capability held, wrong row |
| `AUTHZ_ORGANIZATION_REQUIRED` | 400 | route needs a tenant context |
| `AUTHZ_ORGANIZATION_FORBIDDEN` | 403 | not an active member |
| `AUTHZ_STEP_UP_REQUIRED` | 403 | re-verification needed |
| `AUTHZ_ESCALATION_BLOCKED` | 403 | attempted privilege escalation |
| `AUTHZ_SELF_ASSIGNMENT_BLOCKED` | 403 | tried to change own roles |

## Anti-patterns

```ts
// ❌ Role checks in business logic
if (user.role === 'ADMIN') { ... }
if (principal.platformRoles.includes('PLATFORM_ADMIN')) { ... }

// ✅ Ask for the capability
authz.requirePermission(principal, { resource: 'product', action: 'delete', organizationId });
```

```ts
// ❌ Capability check, then trust the id
requirePermission('product', 'update')       // no resource loader
// controller: prisma.product.update({ where: { id: req.params.id } })
//   → an artist with :own just edited someone else's product

// ✅ Check the row
requirePermission('product', 'update', { resource: (req) => service.refFor(req.params.id) })
```

```ts
// ❌ Trusting a client-supplied identity
const ownerId = req.body.ownerId;

// ✅ Derive it from the session
const ownerId = req.auth.accountId;
```

```ts
// ❌ Filtering after the fact
const all = await prisma.product.findMany();
return all.filter((p) => p.ownerId === userId);     // leaks counts, breaks paging

// ✅ Filter in the query
const where = scopeWhere(buildScopeFilter(principal, request), fields);
```

## Related

- [04 — Scopes & tenancy](04-scopes-and-tenancy.md)
- [07 — Caching](07-caching.md)
- [09 — Security](09-security.md)
