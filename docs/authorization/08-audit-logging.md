# 08 — Audit logging

## What is recorded

| Category | Examples | Recorded when |
|---|---|---|
| Role administration | assign, revoke | always, **awaited** |
| Membership | invite, remove | always, awaited |
| Organization lifecycle | create, update, suspend, delete | always, awaited |
| Sensitive capabilities | refunds, deletions, suspensions, transaction export/reconcile | success **and** denial, automatically |
| Authorization denials | any 403 from `requirePermission` | always, best-effort |

Sensitive capabilities are driven by the catalog's `sensitive: true` flag, so a
new dangerous permission is audited from the moment it is added — no controller
has to remember.

## Schema

```prisma
model AuditLog {
  id             String      @id @default(cuid())
  actorUserId    String?     // null for SYSTEM / WEBHOOK actors
  actorType      String      // USER | SYSTEM | WEBHOOK
  action         String      // "role:assign", "product:delete", …
  resource       String
  resourceId     String?
  organizationId String?
  result         AuditResult // SUCCESS | FAILURE | DENIED
  surface        String?     // app | admin | manage | public
  ipAddress      String?
  userAgent      String?
  requestId      String?
  metadata       Json?
  createdAt      DateTime    @default(now())
}
```

Every field required by the brief is present: actor, action, resource,
resourceId, organizationId, timestamp, result, metadata — plus `surface`,
`ipAddress`, `userAgent` and `requestId` for correlation.

`DENIED` is a separate result from `FAILURE` so that authorization refusals can be
alerted on without drowning in application errors.

`surface` answers "who refunded this, and from where?" — the same action taken
from admin.hitbox.com and from the mobile app are distinguishable.

## Append-only

The repository exposes `append` and `appendMany`. There is deliberately **no
update or delete method**, so application code cannot rewrite history even by
accident. Retention is handled out of band (see below).

## Two write paths

```ts
await audit.record({ … });   // awaited   — failure fails the operation
audit.emit({ … });           // best-effort — failure is logged, never thrown
```

`record()` is used where losing the record is unacceptable: role assignment,
revocation, organization lifecycle. **A grant we cannot account for is treated as
a failed grant** — if the audit write fails, the whole request fails.

`emit()` is used on hot paths — chiefly denials — where an audit outage must not
become a request outage. Failures are logged at `error` level so they are
alertable.

That asymmetry is intentional: role changes are rare and consequential; denials
are frequent and individually less critical, but valuable in aggregate.

## Examples

A role assignment records what changed, in full:

```json
{
  "actorUserId": "usr_priya",
  "actorType": "USER",
  "action": "role:assign",
  "resource": "role",
  "resourceId": "role_PRODUCT_MANAGER",
  "organizationId": "org_acme",
  "result": "SUCCESS",
  "surface": "admin",
  "ipAddress": "203.0.113.7",
  "metadata": {
    "roleKey": "PRODUCT_MANAGER",
    "roleKind": "ORGANIZATION",
    "isPrivileged": false,
    "targetUserId": "usr_bob",
    "expiresAt": null,
    "alreadyHeld": false,
    "grantedPermissions": [
      "product:create:organization",
      "product:delete:organization",
      "product:publish:organization",
      "product:read:any",
      "product:update:organization",
      "category:create:organization",
      "..."
    ]
  }
}
```

`grantedPermissions` is captured at grant time on purpose. If the role's contents
change later, the record still says what was actually handed over — which is the
question an incident review asks.

A denial:

```json
{
  "actorUserId": "usr_bob",
  "action": "product:delete",
  "resource": "product",
  "organizationId": "org_acme",
  "result": "DENIED",
  "surface": "manage",
  "metadata": { "reason": "resource policy denied" }
}
```

Denial reasons are one of: `capability not granted`, `resource policy denied`,
`step-up verification required`.

## Reading the trail

```http
GET /api/v1/admin/authz/audit-logs?resource=role&result=DENIED&limit=50
```

Cursor-paginated. Scope-aware: a holder of `audit-log:read:organization` sees
only their own tenant's rows; only `audit-log:read:any` sees everything. Bulk
export (`audit-log:export`) is sensitive and therefore itself audited and
step-up gated — exporting the audit trail is a notable act.

Query parameters: `actorUserId`, `resource`, `resourceId`, `result`, `from`,
`to`, `limit` (≤200), `cursor`.

## Indexes

```sql
(actor_user_id, created_at)      -- "everything this person did"
(organization_id, created_at)    -- "everything in this tenant"
(resource, resource_id)          -- "everything that happened to this row"
(created_at)                     -- time-range scans
(result, created_at)             -- alerting on denials + retention purge
```

## Alerting

Worth wiring to your monitoring:

| Signal | Query | Why |
|---|---|---|
| Escalation attempts | `action LIKE 'role:%' AND result = 'DENIED'` | someone is probing the role system |
| Denial spike per actor | `result = 'DENIED'` grouped by actor over 5 min | credential compromise, or a broken client |
| Privileged grants | `action = 'role:assign' AND metadata->>'isPrivileged' = 'true'` | should be rare and expected |
| SUPER_ADMIN activity | `metadata->>'roleKey' = 'SUPER_ADMIN'` | should be almost never |
| Money movement | `action IN ('order:refund','refund:process')` | reconcile against the payment provider |
| Audit exports | `action = 'audit-log:export'` | exfiltration signal |
| Cache invalidation failures | application log, `error`, "invalidation failed" | access may be stale |

## Retention

Not implemented as code — it is a deliberate operational decision, and the
recommendation is:

| Class | Retention |
|---|---|
| Financial (refunds, transactions) | 7 years, or whatever local law requires |
| Role/permission changes | 3 years |
| Organization lifecycle | 3 years |
| Denials | 90 days hot, then aggregate |

At volume, partition `audit_logs` by month (`PARTITION BY RANGE (created_at)`) and
drop whole partitions rather than issuing `DELETE`s. The `(result, created_at)`
index supports the interim approach:

```sql
DELETE FROM audit_logs
 WHERE result = 'DENIED'
   AND created_at < now() - interval '90 days';
```

Run it as a scheduled job outside the application, so the append-only contract
holds inside it.

## Related

- [09 — Security](09-security.md)
- [12 — Operations](12-operations.md)
