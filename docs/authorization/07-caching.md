# 07 — Permission caching

Authorization runs on nearly every request, so the effective-permission snapshot
is cached. The relational rows stay authoritative; the cache is derived state and
always safe to throw away.

## Three tiers

```text
request
   │
   ├─► L1  in-process Map            ~µs      per instance,  TTL 5s   (default)
   │        miss ▼
   ├─► L2  Redis                     ~1ms     shared,        TTL 300s (default)
   │        miss ▼
   └─► L3  Postgres (the truth)      ~5-20ms  one query, then written back to L1+L2
```

Implementation: `packages/authz/src/cache/permission-cache.ts`.

## What is cached

One `AuthzPrincipal` per user — the whole snapshot, not individual answers:

```json
{
  "userId": "usr_ayan",
  "platformRoles": ["USER", "ARTIST"],
  "organizations": [
    { "id": "org_acme", "slug": "acme", "name": "Acme Records", "roles": ["PRODUCT_MANAGER"] }
  ],
  "grants": [
    { "resource": "product", "action": "update", "scope": "OWN",          "organizationId": null,      "sensitive": false },
    { "resource": "product", "action": "update", "scope": "ORGANIZATION", "organizationId": "org_acme", "sensitive": false }
  ],
  "builtAt": 1770000000000
}
```

Caching the snapshot rather than per-question results means one lookup serves
every check in a request, and there is one thing to invalidate instead of N.

Key: `authz:principal:{userId}`. The epoch lives **inside** the value, not in the
key, so a targeted `DEL` is exact and does not have to guess which epoch a user
was cached under.

## The single database query

```sql
-- assignments (unexpired) + their roles + those roles' permissions
-- AND active memberships in active, non-deleted organizations
```

Two parallel queries, one round trip's worth of latency
(`AuthzRepository.loadPrincipal`). Expired assignments are filtered **in SQL**, so
a late sweeper job can never leave stale access working, and organization-scoped
assignments are dropped unless an `ACTIVE` membership backs them.

Indexes that serve it:

```text
user_role_assignments  (user_id, organization_id)
role_permissions       (permission_id)          + PK (role_id, permission_id)
organization_memberships (organization_id, status) + UNIQUE (user_id, organization_id)
```

## Invalidation

This is the part that matters. Two mechanisms, for two different blast radii.

### Targeted — one user changed

```ts
await authorization.invalidate(userId);
```

1. drop the local L1 entry
2. `DEL authz:principal:{userId}` — clears L2 for every instance
3. `PUBLISH authz:invalidate {userId}` — every other instance drops its L1 copy

Step 3 is why L1 staleness is bounded by network latency (milliseconds) rather
than by its TTL. Each instance keeps a dedicated ioredis subscriber connection
(connections in subscriber mode cannot issue normal commands, hence the
`duplicate()`).

Called after **every** change to a user's access:

| Trigger | Where |
|---|---|
| role assigned | `RoleAssignmentService.assign` |
| role revoked | `RoleAssignmentService.revoke` |
| default role granted on provisioning | `ensureDefaultRole` |
| added to an organization | `OrganizationService.addMember` |
| removed from an organization | `OrganizationService.removeMember` |
| account deleted/suspended | `users.user.deactivated` subscriber |

Every one of these is covered by a test that asserts `invalidate` was called with
the target's id.

### Tenant-wide — an organization changed

```ts
await organizations.update(...)   // status changed → invalidate every member
```

Suspending or deleting an organization must take effect immediately, because
`loadPrincipal` drops grants for non-ACTIVE organizations. `invalidateMembers`
enumerates the membership and invalidates each user.

### Global — the catalog changed

```ts
await authorization.invalidateEverything();
```

`INCR authz:epoch`. Cached entries carry the epoch they were built under and are
rejected on read, so **every** snapshot is invalidated in O(1) with no key
scanning and no `KEYS`/`SCAN` sweep.

Used when a role's permission set changes — i.e. when the seeder runs. The seeder
CLI does this for you:

```text
✔ permission cache epoch bumped to 7
```

The epoch itself is read from Redis at most once every 5 seconds per instance
(`epochTtlMs`), so this costs roughly nothing on the hot path.

## Staleness bounds

| Change | Worst case before it takes effect |
|---|---|
| role/membership change, Redis healthy | L1 pub/sub latency — milliseconds |
| role/membership change, pub/sub message lost | `AUTHZ_LOCAL_CACHE_TTL_MS` (5s) |
| role/membership change, Redis down | `AUTHZ_LOCAL_CACHE_TTL_MS` (5s), then every request reads Postgres |
| catalog change (seeder) | epoch read TTL (5s) |
| nothing at all invalidated | `AUTHZ_CACHE_TTL_SECONDS` (300s) — the backstop |

The L2 TTL exists precisely so a lost invalidation cannot persist indefinitely.
For operations where even 5 seconds is unacceptable, read fresh:

```ts
const actor = await authorization.getPrincipal(userId, { fresh: true });
```

Role administration endpoints do this unconditionally.

## Failure behaviour

**A cache outage must never become an authorization outage.** Every Redis
interaction is wrapped:

```ts
try {
    const raw = await this.redis.get(this.key(userId));
    // ...
} catch (err) {
    this.logger.warn({ err, userId }, 'authz cache read failed; falling back to database');
    return null;      // → treated as a miss → Postgres
}
```

- **read fails** → treated as a miss, Postgres answers
- **write fails** → logged at `warn`, the request still succeeds
- **invalidation fails** → logged at **`error`**, because access may now be stale
  until the TTL expires. Alert on this.
- **no `REDIS_URL`** → L1-only. Correct on one instance; on several, staleness is
  bounded by the L1 TTL and there is no cross-instance invalidation. Fine for
  local development, **not** for production.

Note that a cache failure degrades toward *reading the truth*, never toward
allowing. There is no code path where a cache error produces a permit.

## Configuration

```bash
REDIS_URL=redis://…                  # unset → L1 only (dev)
AUTHZ_CACHE_TTL_SECONDS=300          # L2 TTL / staleness backstop
AUTHZ_LOCAL_CACHE_TTL_MS=5000        # L1 TTL; 0 disables the L1 tier entirely
```

Set `AUTHZ_LOCAL_CACHE_TTL_MS=0` if you need every request to consult Redis —
strictly more correct, measurably slower. The default of 5s is the trade we
recommend, given pub/sub normally clears L1 far sooner.

## Sizing

A snapshot is roughly 1–4 KB (a `SUPER_ADMIN`, with every platform permission
enumerated, is nearer 20 KB). 100k active users ≈ 100–400 MB of Redis at full
saturation, and the 300s TTL means only genuinely active users occupy space.

## What is *not* cached

- Individual allow/deny answers — the snapshot is enough, and per-answer caching
  multiplies the invalidation problem.
- Resource rows. `refFor()` reads the current owner/tenant every time; caching
  ownership would mean a transfer left the old owner in control.
- The catalog. It is code, loaded at import time.

## Related

- [06 — Backend authorization](06-backend-authorization.md)
- [12 — Operations](12-operations.md)
