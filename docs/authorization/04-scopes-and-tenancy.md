# 04 — Scopes & tenancy

## The three scopes

| Scope | Reaches | Satisfied when |
|---|---|---|
| `own` | Rows the caller owns | `row.ownerId === user.id` |
| `organization` | Rows in the tenant being acted in | `row.organizationId === grant.organizationId` |
| `any` | Every row | always |

```text
own  ⊂  organization  ⊂  any
```

The containment is conceptual. It is **not** used to make decisions — see
[Why grants are evaluated independently](#why-grants-are-evaluated-independently).

## How a scope becomes a decision

Each grant carries the tenant it came from:

```ts
{ resource: 'product', action: 'update', scope: 'ORGANIZATION', organizationId: 'org_acme' }
{ resource: 'product', action: 'update', scope: 'OWN',          organizationId: null }
```

`organizationId: null` means the grant came from a platform role and applies in
every context. Anything else is confined to that one tenant.

The evaluation, in full (`grantAllowsResource`):

```ts
switch (grant.scope) {
    case ANY:
        return true;

    case ORGANIZATION:
        // The row must belong to a tenant, and to THIS grant's tenant.
        return row.organizationId !== null
            && grant.organizationId !== null
            && grant.organizationId === row.organizationId;

    case OWN:
        return row.ownerId !== null && row.ownerId === principal.userId;

    default:
        return false;   // unknown scope → fail closed
}
```

Three fail-closed details worth noting:

- A row with `organizationId === null` (platform-managed) is **unreachable** by an
  organization-scoped grant. There is no tenant to compare against, so we refuse
  rather than assume.
- A row with `ownerId === null` is unreachable by an own-scoped grant, for the
  same reason.
- A grant with `organizationId === null` and `scope === ORGANIZATION` would be
  meaningless. The catalog validator forbids that combination, and the evaluator
  treats it as a deny rather than as "any tenant".

## Why grants are evaluated independently

The tempting implementation is: compute the widest scope the user holds, then
test that one. It is wrong.

```text
Ayan holds:  product:update:own            (platform)
             product:update:organization   @ Acme

Widest scope = organization

Row: Ayan's personal product, organizationId = null
  → organization-scope test fails (no tenant)
  → DENIED, even though product:update:own plainly allows it
```

So instead, every applicable grant is tested and the answer is "allowed if **any**
grant permits this row":

```ts
export function isResourceAllowed(principal, request, resource) {
    return applicableGrants(principal, request).some((grant) =>
        grantAllowsResource(grant, principal, resource),
    );
}
```

This is the behaviour multi-role users need, and it is regression-tested by
`scope-policy.test.ts` → *"evaluates each grant independently for multi-role
users"*.

## Organizations / multi-tenancy

```text
Organization: Acme Records          Organization: Vinyl Co
  ├── ORG_ADMIN         Priya         ├── ORG_ADMIN         Sam
  ├── PRODUCT_MANAGER   Ayan          └── ORDER_MANAGER     Ayan
  └── CONTENT_MANAGER   Ayan
```

Ayan belongs to both, with different roles in each. The model handles this
without any special casing: their `user_role_assignments` rows simply carry
different `organization_id` values.

### Membership is a prerequisite

A role assignment inside a tenant is honoured **only** while the user has an
`ACTIVE` membership in an `ACTIVE`, non-deleted organization. This is enforced in
SQL when the principal is built, not in application code:

```ts
// AuthzRepository.loadPrincipal
const activeOrgIds = new Set(memberships.map((m) => m.organizationId));
// ...
if (organizationId !== null && !activeOrgIds.has(organizationId)) continue;  // drop it
```

Consequences that matter operationally:

- Suspending an organization instantly removes every capability every member had
  inside it.
- Removing a member removes their access even if the role rows lingered — and
  `removeMembership` deletes those rows in the same transaction anyway, so
  re-adding someone later never silently restores old permissions.
- Expired assignments (`expiresAt`) are filtered in SQL, so a late sweeper job
  can never leave stale access working.

### Organization context resolution

One definition, used by every route, so no endpoint can invent its own idea of
"which tenant is this" (`resolveOrganizationContext`):

| Request | Resolved context |
|---|---|
| Route param `:organizationId` | that tenant (params win — the URL is unambiguous) |
| `X-Organization-Id` header | that tenant |
| `?organizationId=` | that tenant |
| named tenant, caller is an active member | that tenant |
| named tenant, not a member, but holds `organization:read:any` | that tenant (platform operator inspecting) |
| named tenant, otherwise | **403** |
| nothing named, exactly one membership | that tenant |
| nothing named, several memberships | `null` — the client must choose |

The last row matters: we never guess which tenant a write lands in. A route that
requires one declares it and gets a clear error:

```ts
requirePermission('product', 'create', { requireOrganization: true })
// → 400 AUTHZ_ORGANIZATION_REQUIRED
```

The platform-operator case is safe because setting a context does not manufacture
grants. A `PLATFORM_ADMIN` inspecting Acme still acts purely through their `any`
permissions; `applicableGrants` only ever surfaces org-tagged grants that are
their own.

A caller who is not a member and not an operator gets the same 403 whether the
organization exists or not — tenant existence is not leaked.

## Organization-scoped resources

For a resource to participate in tenant scoping it needs an `organizationId`
column. `Product` has one:

```prisma
model Product {
  ownerId        String?       @map("owner_id")        // the person
  organizationId String?       @map("organization_id") // the tenant
  organization   Organization? @relation(...)
  @@index([organizationId])
}
```

Both are nullable, which gives four meaningful states:

| `ownerId` | `organizationId` | Reachable by |
|---|---|---|
| set | `null` | the owner (`:own`), platform (`:any`) |
| set | set | the owner, that tenant (`:organization`), platform |
| `null` | set | that tenant, platform |
| `null` | `null` | platform only (`:any`) |

The module that owns the resource exposes ownership and tenancy through a small
loader, and does not import `@hitbox/authz` to do it:

```ts
// packages/products/src/service/product.service.ts
refFor(id: string): Promise<{ ownerId: string | null; organizationId: string | null } | null> {
    return this.deps.products.findAuthorizationRef(id);
}
```

It selects two columns, so a permission check never pulls relations it does not
need and never warms the entity cache on a request that is about to be denied.

## List endpoints

`requirePermission` protects one named row. Collections are different: filtering
after the query leaks row counts and breaks pagination. So instead of *checking*,
we translate grants into a query filter:

```ts
import { buildScopeFilter, scopeWhere } from '@hitbox/authz';

const filter = buildScopeFilter(principal, { resource: 'product', action: 'read', organizationId });
const where  = scopeWhere(filter, { ownerField: 'ownerId', organizationField: 'organizationId' });

if (where === null) return emptyPage();          // no applicable grant → return nothing
return prisma.product.findMany({ where: { ...userFilters, ...where } });
```

| Grants | `visibility` | `where` |
|---|---|---|
| none | `none` | `null` — **return nothing** |
| any `:any` | `all` | `{}` |
| `:own` + `:organization` @ acme | `restricted` | `{ OR: [{ ownerId }, { organizationId: { in: ['acme'] } }] }` |
| `:organization` with no tenant context | `restricted` | `null` |

`null` rather than `{}` is deliberate: an empty object matches every row, so
returning it on a denial would be a full-table leak. `scopeWhere` also returns
`null` when a restricted filter has nothing to restrict to.

## Related

- [02 — Permission model](02-permission-model.md)
- [06 — Backend authorization](06-backend-authorization.md)
- [09 — Security](09-security.md)
