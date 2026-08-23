# 12 — Operations

## First-time setup

```bash
pnpm install
pnpm db:generate                 # merge partials + generate the Prisma client
pnpm db:migrate                  # apply migrations (dev)   — or db:deploy in CI/prod
pnpm authz:seed                  # reconcile the role/permission catalog
```

**Order matters.** Before the seeder runs there are no permission rows, so every
authorization check correctly denies and the API looks broken. That is the
default-deny design working as intended, not a bug.

Bootstrap the first break-glass account (it must have signed in through Clerk at
least once, so a local user row exists):

```bash
pnpm authz:seed -- --super-admin=ops@hitbox.com
```

This is the only sanctioned path — the API deliberately refuses to create a
`SUPER_ADMIN` out of nothing.

## Environment

```bash
# Authorization cache
AUTHZ_CACHE_TTL_SECONDS=300          # L2 (Redis) TTL / staleness backstop
AUTHZ_LOCAL_CACHE_TTL_MS=5000        # L1 (in-process) TTL; 0 disables L1
AUTHZ_STEP_UP_MAX_AGE_MINUTES=15     # how recently a factor must be verified

# Per-surface CORS allowlists (unset = any origin; set these in production)
CORS_APP_ORIGINS=https://hitbox.com,https://www.hitbox.com
CORS_ADMIN_ORIGINS=https://admin.hitbox.com
CORS_MANAGE_ORIGINS=https://productmanager.hitbox.com

# Clerk — list every frontend so a token cannot be replayed across apps
CLERK_AUTHORIZED_PARTIES=https://hitbox.com,https://admin.hitbox.com,https://productmanager.hitbox.com

# Strongly recommended: without Redis the permission cache is per-instance and
# there is no cross-instance invalidation.
REDIS_URL=redis://…
```

## The migration

`packages/shared/database/prisma/migrations/20260820120000_add_authorization_rbac/`

Adds `permissions`, `roles`, `role_permissions`, `organizations`,
`organization_memberships`, `user_role_assignments`, `audit_logs`, and
`products.organization_id`.

Purely additive — nothing is dropped or rewritten, so it is safe on a live
database and reversible by dropping the new objects.

It carries three hand-written statements Prisma cannot express:

```sql
-- Postgres treats NULLs as distinct, so a plain
-- UNIQUE (user_id, role_id, organization_id) would NOT stop duplicate
-- platform-wide grants. Two partial indexes cover both cases exactly.
CREATE UNIQUE INDEX user_role_assignments_user_role_org_key
    ON user_role_assignments (user_id, role_id, organization_id)
    WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX user_role_assignments_user_role_platform_key
    ON user_role_assignments (user_id, role_id)
    WHERE organization_id IS NULL;

-- Serves denial alerting and the retention purge.
CREATE INDEX audit_logs_result_created_at_idx ON audit_logs (result, created_at);
```

If you ever regenerate this migration, re-add them.

## The seeder

`pnpm authz:seed` — idempotent, safe in a deploy pipeline. What it does:

1. **Validates the catalog first.** A malformed role definition can therefore
   never reach the database, so it can never widen access.
2. Upserts every permission from `PERMISSION_CATALOG`.
3. Upserts every role from `ROLE_CATALOG`.
4. **Diffs** role→permission links, so removing a permission from a role in code
   actually removes the grant. A seeder that only ever adds accumulates privilege.
5. Backfills the baseline `USER` role for any existing user without it.
6. Bumps the Redis cache epoch, invalidating every cached snapshot.

Output — the grant diff is printed in full, because a change in what a role can do
is the most security-relevant thing this script does and must never be silent:

```text
Seeding authorization catalog...
  permissions: +3 created, ~1 updated
  roles:       +0 created, ~10 updated
  grants:      +3 added, -1 removed
    + FINANCE_MANAGER <- financial-report:read:organization
    + SUPER_ADMIN <- financial-report:read:any
    - PLATFORM_ADMIN -x- product:delete:any
  ✔ permission cache epoch bumped to 7
Done.
```

### Orphaned permissions

Permissions in the database but no longer in the catalog are **reported, not
deleted**:

```text
  ! 2 permission(s) in the database are no longer in the catalog:
      product:archive:organization
      order:hold:organization
    They were NOT deleted. Remove them with a deliberate migration.
```

Deleting one would cascade its grants away, and a catalog edited on a branch must
not be able to silently strip production access.

## Common tasks

### Add a permission

1. Add it to `PERMISSION_CATALOG` (`packages/authz/src/domain/catalog/permission-catalog.ts`).
2. Add it to the roles that should carry it in `ROLE_CATALOG`.
3. `pnpm test --filter @hitbox/authz` — catalog invariants must pass.
4. `pnpm authz:seed`.
5. Use it: `requirePermission('resource', 'action')`.

### Add a role

1. Add a `RoleDefinition` to `ROLE_CATALOG`.
2. `pnpm authz:seed`.
3. Assign it via `POST /api/v1/admin/authz/users/:userId/roles`.

### Change what a role can do

Edit its `permissions` array and re-seed. The diff is printed; the epoch bump
means it takes effect within seconds everywhere. No deploy of any caller.

### Add a new resource

1. `RESOURCES.THING = 'thing'` in `resources.ts`.
2. Its permissions in `PERMISSION_CATALOG`.
3. Roles that need them in `ROLE_CATALOG`.
4. If it is tenant-owned, add `organizationId` to its Prisma model, plus an index.
5. Expose a `refFor(id)` returning `{ ownerId, organizationId }` from its module.
6. Guard its routes.

### Create an organization and staff it

```bash
# platform operator (organization:create:any)
POST /api/v1/admin/organizations
{ "slug": "acme-records", "name": "Acme Records" }

# add a member (they must already have a platform account)
POST /api/v1/admin/organizations/org_acme/members
{ "email": "priya@acme.example" }

# make them the tenant administrator
POST /api/v1/admin/authz/users/usr_priya/roles
X-Organization-Id: org_acme
{ "roleKey": "ORG_ADMIN" }
```

From then on Priya can appoint `PRODUCT_MANAGER`, `ORDER_MANAGER` and the rest
inside Acme, and cannot touch anything outside it.

### Temporary elevation

```json
POST /api/v1/admin/authz/users/usr_bob/roles
{ "roleKey": "FINANCE_MANAGER", "organizationId": "org_acme", "expiresAt": "2026-09-01T00:00:00Z" }
```

Expired assignments are filtered **in SQL** when the principal is built, so they
stop working at the deadline even if the sweeper is behind. Prune the rows
periodically:

```ts
await authzRepository.deleteExpiredAssignments();
```

### Emergency: revoke someone immediately

```bash
DELETE /api/v1/admin/authz/users/:userId/roles/:roleKey
```

The target's cache is invalidated before the call returns. If they should lose
everything at once, suspend the account instead (`user:suspend`) — `requireAuth`
then rejects them before authorization even runs.

## Retiring `users.role`

The legacy `User.role` column is **deprecated**: nothing reads it, the seeder has
backfilled real `UserRoleAssignment` rows for every user, and
`AccountSnapshot`/`AuthContext` no longer carry a role.

It was deliberately not dropped in the same migration, because a deploy is not
atomic — an old instance still running while the new schema is live would crash on
a missing column.

When you are ready:

1. Confirm nothing references it:
   ```bash
   grep -rn "\.role\b" --include=*.ts packages apps | grep -v node_modules
   ```
2. Confirm every active user has the baseline role:
   ```sql
   SELECT count(*) FROM users u
    WHERE u.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_role_assignments a
          JOIN roles r ON r.id = a.role_id
         WHERE a.user_id = u.id AND a.organization_id IS NULL AND r.key = 'USER');
   -- expect 0
   ```
3. Remove `role` from `packages/users/prisma/users.prisma` and the `UserRole` enum
   from `packages/shared/database/prisma/enums.prisma`.
4. `pnpm db:migrate` and deploy.

## Health checks

```sql
-- Catalog is seeded (expect ~160 permissions, 10 roles)
SELECT count(*) FROM permissions;
SELECT count(*) FROM roles;

-- Nobody is stranded without the baseline role
SELECT count(*) FROM users u WHERE u.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id);

-- Break-glass holders (expect 1-2)
SELECT u.email, a.granted_at
  FROM user_role_assignments a
  JOIN roles r ON r.id = a.role_id
  JOIN users u ON u.id = a.user_id
 WHERE r.key = 'SUPER_ADMIN';

-- Escalation attempts in the last day
SELECT actor_user_id, count(*)
  FROM audit_logs
 WHERE action LIKE 'role:%' AND result = 'DENIED'
   AND created_at > now() - interval '1 day'
 GROUP BY 1 ORDER BY 2 DESC;

-- Assignments that should have expired
SELECT count(*) FROM user_role_assignments WHERE expires_at IS NOT NULL AND expires_at < now();
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every request 403s with `AUTHZ_PERMISSION_DENIED` | seeder never ran | `pnpm authz:seed` |
| A new user can do nothing | `users.user.provisioned` handler failed | check logs; `ensureDefaultRole` is idempotent, re-run the seeder to backfill |
| Role change has no effect | Redis unreachable, so invalidation was lost | check the `error`-level "invalidation failed" log; the L2 TTL clears it within 300s |
| Role change takes ~5s | L1 tier, pub/sub message lost | expected; set `AUTHZ_LOCAL_CACHE_TTL_MS=0` for immediacy |
| `AUTHZ_ORGANIZATION_REQUIRED` | user is in several tenants and sent no header | send `X-Organization-Id` |
| `AUTHZ_ORGANIZATION_FORBIDDEN` | no `ACTIVE` membership, or the org is suspended | check `organization_memberships` and `organizations.status` |
| `AUTHZ_STEP_UP_REQUIRED` on everything sensitive | Clerk JWT template omits `fva` | add the claim; the gate fails closed by design |
| `AUTHZ_MISSING_AUTH_CONTEXT` | `requirePermission` mounted without `requireAuth` | fix the route — this is a wiring bug, and it fails loudly on purpose |
| `AUTHZ_ESCALATION_BLOCKED` | actor is trying to grant beyond their own authority | working as intended; check [09](09-security.md) |
| Cannot revoke the last `SUPER_ADMIN` | lock-out protection | grant it to another account first |

## Tests

```bash
pnpm --filter @hitbox/authz test     # 98 tests
pnpm --filter @hitbox/auth test      # 27 tests
pnpm typecheck                       # every package
```

Suites:

| File | Covers |
|---|---|
| `scope-policy.test.ts` | the decision core: scopes, tenancy, multi-role, list filters |
| `catalog.test.ts` | catalog invariants, naming convention, privilege separation, SUPER_ADMIN |
| `authorization-service.test.ts` | caching, invalidation, fresh reads, the manifest |
| `role-assignment.test.ts` | all six gates, escalation, lock-out protection |
| `require-permission.test.ts` | the middleware end to end, step-up, org context |

The catalog suite is the one that must never be skipped: it is what stops a
careless role edit from shipping.

## Related

- [09 — Security](09-security.md)
- [07 — Caching](07-caching.md)
- [08 — Audit logging](08-audit-logging.md)
