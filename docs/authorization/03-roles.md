# 03 — Roles

## Two kinds

| Kind | `organizationId` | Meaning |
|---|---|---|
| `PLATFORM` | always `NULL` | Granted platform-wide |
| `ORGANIZATION` | always set | Granted inside exactly one tenant |

This is enforced at assignment time, not by convention — granting a platform role
with an organization, or an organization role without one, is rejected.

`PLATFORM` covers both ordinary roles (`USER`, `ARTIST`) and privileged ones
(`PLATFORM_ADMIN`, `SUPER_ADMIN`); `isPrivileged` marks the difference and gates
who may hand them out.

## The catalog

Defined in `packages/authz/src/domain/catalog/role-catalog.ts`. This is the seed
data — `pnpm authz:seed` reconciles it into `roles` + `role_permissions`.

### Platform roles

#### `USER` — everyone

The baseline. Granted automatically the moment a Clerk identity is projected into
a local user row, so "signed in" and "has baseline permissions" can never drift
apart.

```text
profile:read:own            order:create:own         review:create:own
profile:update:own          order:read:own           review:update:own
product:read:any            order:cancel:own         review:delete:own
collection:read:any         payment:read:own         claim:create:own
collection:create:own                                claim:read:own
collection:update:own
collection:delete:own
```

Least privilege by construction: everything is `own`, except reads of public data.
A test asserts this and that `USER` holds nothing sensitive.

#### `ARTIST` — creators

Held **in addition to** `USER`, never instead of it. Effective permissions are the
union, which is why this role only lists what is specific to being an artist.

```text
product:read:any            artist-profile:read:any     order:read:own
product:create:own          artist-profile:update:own   analytics:read:own
product:update:own          collection:read:any
product:delete:own
product:transfer:own
```

#### `PLATFORM_ADMIN` — platform operations *(privileged)*

Broad reach across the platform, and deliberately **not** a superuser. It cannot
manage roles, delete accounts, delete or suspend organizations, or move money.

```text
profile:read:any        product:read:any        content:read:any       order:read:any
user:read:any           product:update:any      content:create:any     order:update:any
user:update:any         product:delete:any      content:update:any     order:cancel:any
user:suspend:any        product:publish:any     content:delete:any     claim:read:any
organization:read:any   category:*:any          content:publish:any    payment:read:any
organization:create:any inventory:read:any      review:delete:any      transaction:read:any
organization:update:any inventory:update:any    analytics:read:any     financial-report:read:any
organization-member:read:any                    audit-log:read:any
role:read:any           permission:read:any     artist-profile:read:any / approve:any
```

Explicitly excluded (and asserted by a test):
`role:assign:any`, `role:revoke:any`, `role:update:any`, `user:delete:any`,
`organization:delete:any`, `organization:suspend:any`, `refund:process:any`,
`order:refund:any`, `transaction:reconcile:any`, `transaction:export:any`,
`audit-log:export:any`.

That split is the point: day-to-day platform operations should not require an
account that can also rewrite the permission model or issue refunds.

#### `SUPER_ADMIN` — break-glass *(privileged)*

See [09 — Security](09-security.md) for the full treatment. In short: every
platform permission, **enumerated explicitly** rather than implemented as a
wildcard, plus step-up on every sensitive capability, full audit, no
self-assignment, and lock-out protection on the last holder.

### Organization roles

#### `ORG_ADMIN`

Runs one tenant. Has **no** platform capability — an organization administrator is
not a step towards platform administrator.

```text
organization:read:organization          user:read:organization
organization:update:organization        user:update:organization
organization-member:read:organization   user:suspend:organization
organization-member:invite:organization audit-log:read:organization
organization-member:delete:organization analytics:read:organization
role:read:organization                  product:read:any
role:assign:organization
role:revoke:organization
```

`product:read:any` is the one platform-wide entry, and it is a read of the public
catalog. The catalog validator allows `any` scope for organization roles only on
read-only actions.

#### `PRODUCT_MANAGER`

```text
product:read:any                  category:read:organization      inventory:read:organization
product:create:organization       category:create:organization    inventory:update:organization
product:update:organization       category:update:organization
product:delete:organization       category:delete:organization
product:publish:organization
```

#### `CONTENT_MANAGER`

```text
content:read:organization      content:publish:organization
content:create:organization    product:read:any
content:update:organization    product:update:organization
content:delete:organization
```

#### `ORDER_MANAGER`

```text
order:read:organization    order:cancel:organization    order:ship:organization
order:update:organization  order:refund:organization
```

#### `SUPPORT_AGENT`

```text
customer:read:organization    product:read:any
order:read:organization       refund:request:organization
order:update:organization
```

Note what is missing: `refund:process`. Support can *raise* a refund request; only
`FINANCE_MANAGER` can execute one. That separation of duties is intentional and is
the reason `refund:request` and `refund:process` are distinct actions.

#### `FINANCE_MANAGER`

```text
order:read:organization       transaction:read:organization
payment:read:organization     transaction:export:organization
refund:process:organization   transaction:reconcile:organization
                              financial-report:read:organization
```

## Multi-role users

A user holds many roles. **Effective permissions are the union of all of them**,
evaluated per tenant context.

```text
Ayan
 ├── USER                              (platform)
 ├── ARTIST                            (platform)
 ├── PRODUCT_MANAGER   @ Acme Records  (organization)
 └── CONTENT_MANAGER   @ Acme Records  (organization)
```

Acting inside Acme, Ayan's applicable grants are: everything from USER + ARTIST
(platform grants apply everywhere) + everything from both Acme roles. Acting with
no tenant context, only the platform grants apply.

### Conflict resolution

**Default deny with explicit grants only.** There are no deny rules, so there is
nothing to conflict: a capability is either granted by some applicable role or it
is refused. Two roles granting the same permission is not a conflict — the grant
list is deduplicated.

Crucially, grants are evaluated **independently** rather than collapsed to the
widest scope:

```ts
// Ayan holds product:update:own AND product:update:organization @ Acme
isResourceAllowed(ayan, req, { ownerId: ayan.id, organizationId: null })  // ✅ via :own
isResourceAllowed(ayan, req, { ownerId: 'other', organizationId: acme })  // ✅ via :organization
isResourceAllowed(ayan, req, { ownerId: 'other', organizationId: other }) // ❌
```

An implementation that picked the widest scope (`organization`) and tested only
that would wrongly **deny** the first case — Ayan's own product has no tenant.
This is covered by a test named for exactly that scenario.

The widest scope is still computed, but only for reporting: it is what
`/authz/me` sends the frontend so a client can ask "can I edit anything, or only
my own?".

### If deny rules are ever added

They are not needed today and should be resisted. If a future requirement forces
them:

1. Deny must be **absolute** — one deny beats every allow, at every scope.
2. Deny must be evaluated **after** all allows are collected, never short-circuit.
3. A deny must be **auditable** by itself: which role introduced it, and when.
4. The catalog validator must reject a role holding both allow and deny for the
   same `resource:action`.

Until all four are implemented and tested, the answer is "narrow the roles".

## Avoiding role explosion

Never create a role per combination.

```text
❌  PRODUCT_MANAGER_INDIA
❌  PRODUCT_MANAGER_US
❌  PRODUCT_MANAGER_READ_ONLY
❌  PRODUCT_MANAGER_PRODUCTS_ONLY
```

Those are four dimensions being smuggled into a name. Use the dimensions the
model already has:

| You want | Use |
|---|---|
| Same job, different region/brand | One `PRODUCT_MANAGER` role, assigned in a different **organization** |
| Read-only variant | A separate role with only `read` permissions, or narrow the existing one |
| Narrower subject area | Split by **resource**, not by role name |
| Temporary elevation | The same role with `expiresAt` set |

```text
Role  +  Permission  +  Scope  +  Organization
```

Four independent axes. Ten roles across N organizations covers what would
otherwise be hundreds of role names. If you find yourself wanting an eleventh
role, check first whether it is really an existing role in a new organization.

## Creating a new role

1. Add a `RoleDefinition` to `ROLE_CATALOG`, listing permission keys.
2. `pnpm authz:seed` — the grant diff is printed line by line.
3. Assign it: `POST /api/v1/admin/authz/users/:userId/roles`.

The catalog validator (run by the seeder *and* by CI) rejects:

- a permission key that does not exist
- a `PLATFORM` role holding an `organization`-scoped permission
- an `ORGANIZATION` role holding a mutating `any`-scoped permission
- an `ORGANIZATION` role holding a sensitive `any`-scoped permission
- a privileged role that is not a platform role
- a role with no permissions, or a duplicated key

## Related

- [04 — Scopes & tenancy](04-scopes-and-tenancy.md)
- [09 — Security](09-security.md) — SUPER_ADMIN and escalation guards
- [12 — Operations](12-operations.md)
