# 09 — Security

## Default deny

Nothing is permitted unless an explicit grant says so. Concretely:

```ts
hasPermission(principal, request)      // false when grants list is empty
isResourceAllowed(...)                 // .some(...) over an empty list → false
grantAllowsResource(...) default:      // unknown scope → false
scopeWhere({ visibility: 'none' })     // null, NOT {} — "return nothing"
assertStepUpSatisfied(no fva claim)    // throws
```

There is no code path where a missing grant, an unknown scope, a cache error or a
malformed token produces a permit. The one place this could plausibly have gone
wrong — `scopeWhere` for list endpoints — returns `null` rather than an empty
`where` object, because `{}` matches every row.

## Least privilege

Built into the role design rather than left to discipline:

- `USER` is `own`-scope only, apart from reads of public data, and holds nothing
  sensitive. Both are asserted by tests.
- `ARTIST` is additive to `USER` and confined to `own`.
- `PLATFORM_ADMIN` deliberately **excludes** role management, account deletion,
  organization deletion/suspension and anything that moves money. Day-to-day
  platform operations should not require an account that can rewrite the
  permission model.
- `SUPPORT_AGENT` can *request* a refund; only `FINANCE_MANAGER` can *process*
  one. Separation of duties expressed as two actions, not a code branch.
- Organization roles cannot mutate outside their tenant — the catalog validator
  rejects a mutating `any`-scoped permission on an `ORGANIZATION` role.

## No frontend trust

The frontend receives a *description* of access (`GET /authz/me`) purely to render
UI. Every request is re-checked server-side against live database state.

Hiding a Delete button changes nothing about `DELETE /api/v1/products/:id`. That
route carries `requirePermission('product', 'delete', { resource: … })`, and it is
the route — not the button — that decides.

## No scattered role checks

`if (role === 'ADMIN')` appears nowhere. Business logic asks for capabilities; the
role→permission mapping lives entirely in seed data. The practical benefit is that
changing what a role can do never touches code, so there is no risk of a caller
being missed.

The one place role *keys* are referenced is `RoleAssignmentService`, and only
structurally (`isPrivileged`, `kind`), plus one named check: the lock-out
protection on the last `SUPER_ADMIN`.

## Preventing privilege escalation

Role assignment is the one operation that can change what every other check
decides, so it passes six gates in order
(`packages/authz/src/service/role-assignment.service.ts`):

| # | Gate | Rejects with |
|---|---|---|
| 1 | role exists and is assignable | `ROLE_NOT_FOUND` |
| 2 | target user exists and is not deleted | `ROLE_NOT_FOUND` |
| 3 | **nobody may change their own assignments** | `SELF_ASSIGNMENT_BLOCKED` |
| 4 | role kind matches the context | `ROLE_NOT_ASSIGNABLE` / `ORGANIZATION_REQUIRED` |
| 5 | actor holds `role:assign` reaching this context; privileged/platform roles need `role:assign:any` | `ESCALATION_BLOCKED` / `PERMISSION_DENIED` |
| 6 | no horizontal or vertical escalation | `ESCALATION_BLOCKED` |

### Gate 3 — no self-elevation

Even a `SUPER_ADMIN` must go through another administrator to change their own
grants. This is what makes the audit trail meaningful, and it stops a compromised
session from quietly widening itself. Applies to revocation too.

### Gate 6 — the escalation rule

Two regimes, because the right answer differs:

**Privileged or platform roles → strict superset.** The actor must already hold
every capability the role carries, at least as widely. So only a `SUPER_ADMIN` can
mint a `SUPER_ADMIN`, and nobody can bootstrap a capability they lack by routing
it through a role.

**Ordinary organization roles → delegation.** An `ORG_ADMIN` is *meant* to appoint
a `PRODUCT_MANAGER` without personally holding `product:create:organization` —
that is what `role:assign:organization` is for. Requiring a superset here would
force `ORG_ADMIN` to be a union of every organization role, which is the opposite
of least privilege. What remains forbidden is handing out a mutating
platform-wide (`any`) capability, which would escape the tenant.

### The headline guarantee

> An organization-level administrator does not become a platform administrator.

Mechanism: `PLATFORM_ADMIN` and `SUPER_ADMIN` are `isPrivileged`, so granting
either requires `role:assign:any`. `ORG_ADMIN` holds only
`role:assign:organization`. There is no sequence of legal calls that gets from one
to the other. Tested from four angles:

```text
✓ an ORG_ADMIN cannot mint a PLATFORM_ADMIN
✓ an ORG_ADMIN cannot mint a SUPER_ADMIN
✓ an ORG_ADMIN cannot even grant the plain USER platform role
✓ an ORG_ADMIN cannot appoint into a DIFFERENT tenant
```

## Handling SUPER_ADMIN

The brief warns against implementing it as a simple wildcard. It is not one.

**1. Explicitly enumerated, never a wildcard.** `SUPER_ADMIN` is seeded with every
platform permission expanded into real `role_permissions` rows. A `SELECT` shows
exactly what it can do, and there is **no short-circuit anywhere in the request
path** — a `SUPER_ADMIN` request runs the same grant lookup as everyone else. A
`role === 'SUPER_ADMIN' → allow` branch would be unauditable and would silently
grant any permission added later; this design cannot.

**2. No organization-scoped permissions.** Those are meaningless for a
platform-wide assignment (there is no tenant to compare against). This is not a
gap: a test asserts that *every* organization-scoped capability has an
`any`-scoped counterpart that strictly supersedes it, so the coverage is
redundant rather than missing.

**3. New permissions are visible when granted.** The seeder prints the grant diff
line by line:

```text
grants: +3 added, -1 removed
    + SUPER_ADMIN <- financial-report:read:any
    - PLATFORM_ADMIN -x- product:delete:any
```

A permission quietly appearing in the break-glass role is the kind of change that
must be reviewed, so it is impossible to apply silently.

**4. Step-up on every sensitive capability.** Holding a dangerous permission is
not the same as having recently proved you are still the person who holds it.

**5. Fully audited**, with the granted permission list captured at grant time.

**6. Lock-out protection.** Revoking the last `SUPER_ADMIN` is refused —
recovering from an empty set requires direct database access.

**7. No self-assignment**, per gate 3.

### Operating it

- Keep the holder count in single digits — ideally two, for redundancy.
- Use it for break-glass only. Routine work belongs to `PLATFORM_ADMIN` and the
  organization roles.
- Bootstrap the first one from the CLI, which is the only sanctioned path:

  ```bash
  pnpm authz:seed -- --super-admin=ops@hitbox.com
  ```

  The API deliberately cannot create one out of nothing.
- Alert on every `SUPER_ADMIN` action (see [08](08-audit-logging.md)).
- Consider time-boxing it: `expiresAt` on the assignment turns it into temporary
  elevation, and expired rows are filtered in SQL.

## Step-up (re-verification)

Sensitive capabilities additionally require a recently verified authentication
factor. The gate reads Clerk's `fva` claim:

```text
fva = [ minutes since first factor verified, minutes since second factor verified ]
      -1 = not applicable
```

Either factor being fresh enough satisfies the gate — a second factor verified
just now is at least as strong as a first factor. Threshold:
`AUTHZ_STEP_UP_MAX_AGE_MINUTES` (default 15).

**It fails closed.** No `fva` claim → `AUTHZ_STEP_UP_REQUIRED`, and the client is
expected to run Clerk's re-verification flow and retry.

`iat` is deliberately not used: Clerk session tokens are short-lived and silently
refreshed, so `iat` is always seconds old and every request would look freshly
authenticated.

Because sensitivity is a catalog flag, the gate applies uniformly with no
per-controller code. `skipStepUp` exists as an escape hatch and requires a written
reason, so it shows up in review.

## Tenant isolation

Enforced in four independent places, so a single mistake is not sufficient:

1. **Grant filtering** — `applicableGrants` drops grants whose `organizationId`
   does not match the active context. A grant from tenant B is invisible while
   acting in tenant A.
2. **Resource policy** — `ORGANIZATION` scope requires
   `grant.organizationId === row.organizationId`, and refuses rows with no tenant.
3. **Membership** — organization-scoped assignments are honoured only while an
   `ACTIVE` membership in an `ACTIVE` organization backs them, filtered in SQL.
4. **Context resolution** — claiming a tenant you are not a member of is a 403
   before any handler runs.

Existence is not leaked: a non-member gets the same 403 whether the organization
exists or not.

## Other controls

| Control | Where |
|---|---|
| Per-surface CORS allowlists | `apps/backend/src/middleware/surface-cors.middleware.ts` |
| Per-surface rate limits (admin/manage at half budget, separate Redis buckets) | `apps/backend/src/routes.ts` |
| Role administration unroutable from customer/mobile surfaces | `apps/backend/src/surfaces/` |
| `helmet` security headers | `apps/backend/src/app.ts` |
| Webhook signature verification over the raw body + svix-id idempotency | `packages/auth` |
| `CLERK_AUTHORIZED_PARTIES` — a token minted for one app cannot be replayed at another | `require-auth.middleware.ts` |
| Suspended/deleted/unverified accounts rejected before authorization runs | `require-auth.middleware.ts` |
| Membership removal deletes tenant role rows in the same transaction | `OrganizationRepository.removeMembership` |
| Organizations are soft-deleted so the audit trail survives | `OrganizationService.remove` |
| Two partial unique indexes prevent duplicate grants despite NULL semantics | the migration |

## Known limitations

Stated plainly, because undocumented gaps are worse than known ones:

- **L1 cache staleness.** Up to `AUTHZ_LOCAL_CACHE_TTL_MS` (5s) if a pub/sub
  invalidation message is lost. Set it to `0` for strict correctness at the cost
  of a Redis round trip per request. Sensitive operations already read `fresh`.
- **No deny rules.** Allow-only, by design. Adding deny requires the four
  conditions in [03 — Roles](03-roles.md#if-deny-rules-are-ever-added).
- **Field-level authorization is out of scope.** Permissions gate whole
  operations. If one field needs separate authority, model it as its own resource.
- **`users.role` still exists** as a deprecated column. Nothing reads it; it is
  dropped in a follow-up migration ([12](12-operations.md)).
- **Retention/purge is not implemented.** It is an operational job, sketched in
  [08](08-audit-logging.md).
- **`fva` depends on Clerk's JWT template.** If the claim is removed, every
  sensitive capability becomes unusable (fails closed) rather than unguarded —
  the safe direction, but it will page you.

## Review checklist for new endpoints

- [ ] `requireAuth` before `requirePermission`
- [ ] The permission names a business capability, not a UI element
- [ ] A `resource` loader is supplied for any route addressing a specific row
- [ ] List endpoints use `buildScopeFilter` + `scopeWhere`, not post-filtering
- [ ] Owner ids come from `req.auth.accountId`, never from the request body
- [ ] `requireOrganization: true` on routes that must have a tenant
- [ ] The route is mounted on the narrowest surface that needs it
- [ ] A dangerous new capability is marked `sensitive` in the catalog
- [ ] No role names in business logic

## Related

- [03 — Roles](03-roles.md)
- [06 — Backend authorization](06-backend-authorization.md)
- [08 — Audit logging](08-audit-logging.md)
