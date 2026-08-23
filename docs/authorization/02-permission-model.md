# 02 — Permission model

## Naming convention

```text
<resource>:<action>:<scope>
```

| Segment | Rule | Examples |
|---|---|---|
| `resource` | lowercase kebab-case, singular noun | `product`, `artist-profile`, `financial-report` |
| `action` | lowercase kebab-case verb, a **business capability** | `read`, `create`, `publish`, `reconcile` |
| `scope` | `own` \| `organization` \| `any` | see [04 — Scopes](04-scopes-and-tenancy.md) |

```text
product:update:own
order:refund:organization
user:read:any
```

Lowercase on the wire (APIs, logs, the frontend manifest); the scope is stored as
an uppercase Prisma enum. `parsePermissionKey` enforces the convention and throws
on anything malformed, so a typo fails at boot rather than silently denying — or
worse, silently allowing — at request time.

Implementation: `packages/authz/src/domain/permission-key.ts`.

## Roles are not permissions

A role is a *bundle*. Business logic never mentions a role.

```text
PRODUCT_MANAGER              ← configuration, referenced only by seed data
    ├── product:read:any
    ├── product:create:organization
    ├── product:update:organization
    ├── product:delete:organization
    └── product:publish:organization
                                  ↑ this is what code depends on
```

Which means changing what a product manager can do is a data change, not a code
change. Nothing recompiles, no caller is touched.

## The catalog is code, the grants are data

Two different things, deliberately stored differently:

| | Where | Why |
|---|---|---|
| Which permissions **exist** | `permission-catalog.ts` (code) | Reviewable in a pull request, diffable, testable |
| Who **holds** a permission | `permissions` / `roles` / `role_permissions` / `user_role_assignments` | Changes at runtime without a deploy |

The `permissions` table is a *reconciled projection* of the catalog, written by
`pnpm authz:seed`. Never edit it by hand in production.

### The closed set

`RESOURCES` and `ACTIONS` are closed enums
(`packages/authz/src/domain/catalog/resources.ts`), so `requirePermission` is
typed:

```ts
requirePermission('prodcut', 'update')   // ← compile error, not a silent deny
```

An open string would let a typo become a permission no role can ever hold, which
denies every caller — a bug that looks like correct security until someone
reports they cannot do their job.

## Sensitivity is data, not code

Each catalog entry can be marked sensitive:

```ts
{
    action: ACTIONS.REFUND,
    scopes: [ORG, ANY],
    description: 'Refund an order',
    sensitive: true,
}
```

Sensitive capabilities automatically require step-up re-verification and are
always audited, everywhere, with no per-controller code. See
[09 — Security](09-security.md).

Currently sensitive: role assign/revoke/update, user suspend/delete,
organization suspend/delete, member removal, refunds (`order:refund`,
`refund:process`), transaction export/reconcile, `product:delete:any`,
`audit-log:export`.

## Avoiding permission explosion

**Permissions describe business capabilities, never UI.**

```text
❌  product:show-delete-button:any
❌  product:show-edit-button:any
❌  dashboard:view-revenue-widget:any

✅  product:delete:organization
✅  product:update:organization
✅  financial-report:read:organization
```

The frontend derives UI from capabilities — a Delete button renders because the
manifest contains `product:delete:*`, not because a permission exists whose only
meaning is "render a button". A test enforces this: `catalog.test.ts` fails if any
resource or action contains `button`, `menu`, `tab`, `page`, `screen`, `modal`,
`show` or `hide`.

Other rules that keep the count down:

- **No per-field permissions.** `product:update:organization`, not
  `product:update-price` + `product:update-name` + … If one field genuinely needs
  separate authority, that is a signal it belongs to a different resource.
- **`read` covers single and list reads.** A separate `list` action doubles the
  catalog and is almost never granted differently.
- **No per-region or per-brand permissions.** That is what scope and the
  organization dimension are for — see [Avoiding role explosion](03-roles.md).

## The current catalog

Generated from `PERMISSION_CATALOG`. `GET /api/v1/admin/authz/permissions`
returns the live version.

| Resource | Actions (scopes) |
|---|---|
| `profile` | read (own, any), update (own) |
| `user` | read (own, org, any), update (own, org, any), **suspend** (org, any), **delete** (any) |
| `customer` | read (org, any) |
| `product` | read (own, org, any), create (own, org, any), update (own, org, any), delete (own, org, **any**), publish (org, any), transfer (own, any) |
| `category` | read / create / update / delete (org, any) |
| `inventory` | read / update (org, any) |
| `collection` | read (own, any), create / update / delete (own, any) |
| `artist-profile` | read (own, any), update (own, org, any), approve (org, any) |
| `claim` | read (own, any), create (own) |
| `review` | read (any), create (own), update (own, org, any), delete (own, org, any) |
| `content` | read / create / update / delete / publish (org, any) |
| `order` | read (own, org, any), create (own), update (org, any), cancel (own, org, any), **refund** (org, any), ship (org, any) |
| `payment` | read (own, org, any) |
| `refund` | request (org, any), **process** (org, any) |
| `transaction` | read (org, any), **export** (org, any), **reconcile** (org, any) |
| `financial-report` | read (org, any) |
| `analytics` | read (own, org, any) |
| `organization` | read (org, any), create (any), update (org, any), **suspend** (any), **delete** (any) |
| `organization-member` | read (org, any), invite (org, any), **delete** (org, any) |
| `role` | read (org, any), **assign** (org, any), **revoke** (org, any), **update** (any) |
| `permission` | read (any) |
| `audit-log` | read (org, any), **export** (org, any) |

**Bold** = sensitive (step-up + always audited).

## Adding a permission

1. Add it to `PERMISSION_CATALOG`.
2. Add it to whichever roles should carry it in `ROLE_CATALOG`.
3. `pnpm authz:seed` — prints the exact grant diff.
4. Use it: `requirePermission('resource', 'action')`.

No middleware, service or controller changes. The catalog tests run as part of
`pnpm test`, so a role that references a non-existent permission, or an
organization role that would break tenant isolation, fails CI.

## Related

- [03 — Roles](03-roles.md)
- [04 — Scopes & tenancy](04-scopes-and-tenancy.md)
- [12 — Operations](12-operations.md)
