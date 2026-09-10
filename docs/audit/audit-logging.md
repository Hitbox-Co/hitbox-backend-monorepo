# HitBox Audit Logging

> What gets recorded, which events count as sensitive, and how long any of it is kept.
>
> Companion reading: [database-architecture.md](database-architecture.md) §3.5 (why the trail has no
> foreign keys), [authorization/](authorization/authorization-architecture.md) (the capabilities that
> guard the read API).

**This replaces the `AuditLog` model in the old `08-audit-logging.md`.** That single table never
existed. The real trail is three: `AuditEventType`, `AuditEvent`, `AuditRetentionPolicy`.

---

## 1. What this is

**The big idea: severity belongs to the event type, not the call site.**

The old design had a `sensitive` flag every controller had to remember to set. This one has a
catalog. `order.refund` is registered once as `CRITICAL`, and every caller inherits that.

```text
   AUDIT_EVENT_CATALOG (code, 28 events)
              │  seedAudit() copies it into
              ▼
      AuditEventType (table — new events need no migration)
              │  recorder reads defaultSeverity when writing
              ▼
        AuditEvent (append-only)
              │
      severity → retention + alerting
      correlationId → one request's events, joined
```

A caller says `record('order.refund', …)` and cannot forget it's sensitive, or quietly downgrade it.

| Piece | Where |
|---|---|
| Event catalog | `packages/audit/src/domain/audit-event-catalog.ts` |
| Write port | `packages/audit/src/domain/interfaces/audit-recorder.interface.ts` |
| Recorder | `packages/audit/src/service/audit-recorder.service.ts` |
| Read API | `packages/audit/src/service/audit-query.service.ts` |
| Tables | `packages/audit/prisma/audit.prisma` — 3 tables, 7 indexes |
| Tests | `packages/audit/tests/` — 98 across 5 suites |

**Not wired yet.** Nothing outside this package imports `@hitbox/audit`, so no business action writes
a trail today. The events are registered; the call sites are still to come. See §10.

---

## 2. What gets recorded

`AuditEventType` is a table, not an enum, so an event can be registered without a migration. Each
row: `eventType`, `personaGroup`, `description`, `defaultSeverity`, `sourceStories`, `isActive`.

`sourceStories` cites the requirement that justified the event. "Why do we log this?" is the first
question a review asks, and every event answers it on its own row.

The code catalog is the seed source and the fast path — not a second gate. A row inserted straight
into the table still works: the recorder falls back to reading the table for keys it doesn't know.

**28 events: 20 CRITICAL, 4 WARNING, 4 INFO.**

- **WARNING** — `permission.catalog.sync`, `organization.update`, `release.approve`, `release.reject`
- **INFO** — `audit.read`, `product.create`, `product.update`, `content.unlock`

---

## 3. Sensitive events

**Sensitive = `defaultSeverity: CRITICAL`.** One field, one file. No `sensitive` boolean, no naming
convention, no second list.

### The 20

| Group | Events |
|---|---|
| Role grants | `role.create`, `role.update`, `role.delete`, `role.assign`, `role.revoke` |
| Deletions | `organization.delete`, `user.delete`, `product.delete`, `claim.revoke` |
| Suspensions | `organization.suspend`, `user.suspend` |
| Money | `order.refund`, `refund.process`, `payment.gateway.configure`, `royalty.override` |
| The trail itself | `audit.export`, `audit.retention-policy.update` |
| Provenance | `nfc-tag.claim`, `ownership.transfer` |
| Onboarding | `organization.create` |

That's the old `sensitive` flag one-for-one — refunds, deletions, suspensions, exports, role grants
— plus provenance, which the old model had no concept of.

### What CRITICAL buys you, automatically

- The row is **written** CRITICAL — the caller can't forget or override it.
- It's **kept 7 years** instead of 3 years or 90 days. That's the cost side of the decision.
- It lands in the **"review the list, not the count"** alert (§8).

### A denied sensitive action is not sensitive

`DENIED` becomes `WARNING`, whatever the event type says, because **nothing changed**. A refused
`product.delete` is worth keeping and worth alerting on in aggregate, but it isn't a delete. Left at
CRITICAL, routine denials would bury the few rows that need reading one by one.

`FAILURE` keeps the catalog severity — a refund that died halfway is at least as serious as one that
worked.

### Checking the set

From `packages/audit`:

```bash
pnpm exec tsx -e "import {AUDIT_EVENT_CATALOG as c} from './src/domain/audit-event-catalog'; const s=c.filter(e=>e.defaultSeverity==='CRITICAL'); console.log('SENSITIVE: '+s.length+' of '+c.length); s.forEach(e=>console.log('  '+e.eventType.padEnd(32)+e.personaGroup))"
```

13 of the 20 are pinned by name in `tests/audit-event-catalog.test.ts`, so they can't silently drop
below CRITICAL. The other 7 aren't, and nothing asserts the set is exactly 20.

---

## 4. Two write paths

```ts
await audit.record({ … }, { tx })   // awaited, throws
audit.emit({ … })                   // best-effort, never throws
```

**`record()`** — anything CRITICAL. If the row can't be written it throws and the caller's operation
fails. A grant nobody can account for is a failed grant.

Pass `tx` when you have a transaction. Awaiting alone doesn't stop a committed change whose audit row
failed — it only tells you about it. `tx` makes both commit or both roll back.

**`emit()`** — hot paths, mainly DENIED results: frequent, individually cheap, valuable in bulk. It
logs the failure and publishes `audit.write.dropped`, but never throws. An audit outage must not
become a request outage.

It returns `void`, not a promise, on purpose — a promise invites `await audit.emit(...)`, which puts
the audit database right back on the request path.

---

## 5. The event row

Primary key is `(eventId, occurredAt)` — composite so the table can be partitioned by month for
pruning without losing uniqueness.

| Field | Note |
|---|---|
| `actorType` / `actorId` | `actorId` is null for `SYSTEM`. **Not** a foreign key |
| `actorRoleSnapshot` | Roles *at the time*, so a later role change can't rewrite history |
| `organizationId`, `resourceType`, `resourceId` | **Not** foreign keys |
| `actionResult` | `SUCCESS` / `FAILURE` / `DENIED` — a refusal and an error are different things |
| `severity` | From the catalog at write time (§3) |
| `beforeState` / `afterState` | Json. Absent is SQL `NULL`, not JSON `null` |
| `correlationId` | **Required.** Joins one request's events together |
| `ledgerReferenceId` | For provenance actions, the `BlockchainLedger` row produced |
| `insertedAt` | Always the write time. The gap from `occurredAt` shows clock skew and late writes |

No foreign keys, deliberately: the trail must outlive the records it describes, and must never be the
reason a delete fails. See [database-architecture.md](database-architecture.md) §3.5.

Mount `correlationId()` **before** authentication — a DENIED result is one of the most useful things
in the trail, and it happens before the request has an identity.

### Example — a role assignment

```text
eventType:  role.assign          severity:      CRITICAL   ← from the catalog
actorType:  HITBOX_ADMIN         actionResult:  SUCCESS
resource:   role / <role id>     organizationId: <org id>
afterState: { "roleKey": "PRODUCT_MANAGER", "targetUserId": "…" }
metadata:   { "grantedPermissions": ["product:create:organization", "…"] }
```

Capture `grantedPermissions` at grant time. If the role changes later, the record still says what was
actually handed over — which is what a review asks.

---

## 6. Reading the trail

| Route | Capability |
|---|---|
| `GET /admin/audit/events` | `audit-log:read` |
| `GET /admin/audit/events/correlation/:id` | `audit-log:read` |
| `GET /admin/audit/event-types` | `audit-log:read` |
| `GET /admin/audit/export` | `audit-log:export` + step-up |
| `GET /admin/audit/retention` (+ `/prune-plan`) | `audit-log:read` |
| `PATCH /admin/audit/retention/:severity` | `audit-log:manage` |

Filters: `eventType`, `actorId`, `organizationId`, `resourceType`, `resourceId`, `actionResult`,
`severity`, `correlationId`, `from`, `to`, `limit` (max 200), `cursor`. Each maps to an index (§9).

**Paging is keyset, not OFFSET.** The cursor is `(occurredAt, eventId)` — the primary key's own
ordering — so a page boundary holds even while rows are being appended. OFFSET shifts under
concurrent writes, and a reviewer paging through a live incident would skip rows.

**Scoping.** A global reader sees everything. An org reader gets `organizationId` pinned to their own
*before the query runs*. Asking for another org is a 403, not an empty page — an empty result would
let someone probe which org ids exist.

**Reads are recorded** (`audit.read`, best-effort). Opening the audit screen must not 500 because the
trail couldn't log that you opened it.

**Export** is streamed NDJSON, needs a bounded window and a written reason, and records
`audit.export` *before the first row is read* — so an abandoned export is still on the record. The
route isn't mounted at all without a step-up handler: export is the exfiltration path, so the gate is
what enables the route.

---

## 7. Retention

One row per severity, keyed by severity, so the pruner never has to guess.

| Severity | Days | Why |
|---|---|---|
| `CRITICAL` | 2,555 | 7 years. Money, access changes, org lifecycle. Raise for local law; never lower without legal sign-off |
| `WARNING` | 1,095 | 3 years. Denials and non-critical failures — long enough to see a slow-burn pattern |
| `INFO` | 90 | 90 days hot, then aggregate. High volume, low value per row |

Because it's a table, an operator edits the row and the next sweep picks it up — no deploy. The seed
**fills gaps only**; it never overwrites a window someone widened for a legal hold.

Changing a window is itself CRITICAL, recorded with both snapshots and a
`direction: shortened | lengthened`. The change and its record share a transaction — shortening a
window is how you'd destroy evidence.

**Nothing here deletes an event.** `prunePlan()` only reports cutoffs and row counts. Actual pruning
is a scheduled job outside the app that drops whole monthly partitions.

Two things the schema can't enforce, so they're **operational prerequisites**:

1. Partition `AuditEvent` by month on `occurredAt`.
2. Revoke `UPDATE` and `DELETE` on `AuditEvent` from the app's database credentials. Today
   append-only is convention plus the absence of any delete path in code.

---

## 8. Alerting

```sql
"eventType" LIKE 'role.%' AND "actionResult" = 'DENIED'   -- probing the role system
"actionResult" = 'DENIED' GROUP BY "actorId"              -- over 5 min: compromise or broken client
"severity" = 'CRITICAL'                                   -- rare and expected; read the list
"eventType" = 'role.assign' AND "afterState"->>'roleKey' = 'HITBOX_SYSTEM_ADMIN'
"eventType" IN ('order.refund', 'refund.process')         -- reconcile with the payment provider
"eventType" = 'audit.export'                              -- exfiltration signal
"actionResult" = 'FAILURE' AND "ledgerReferenceId" IS NOT NULL  -- ownership state may be stale
```

The first and third don't overlap: role denials are `WARNING` (§3), so they stay out of the CRITICAL
list. That's the point — CRITICAL stays short enough to read, denials get caught by rate instead.

---

## 9. Indexes

Seven, all non-unique — uniqueness is the primary key's job, and a unique index here would reject the
second event of a burst sharing an actor or correlation id.

| Index | Serves |
|---|---|
| `(actorId, occurredAt)` | "Everything this person did" |
| `(organizationId, occurredAt)` | Tenant-scoped reads |
| `(resourceType, resourceId)` | "Everything that happened to this row" |
| `(occurredAt)` | Time ranges, the pruner's sweep |
| `(actionResult, occurredAt)` | Denial alerts, retention queries |
| `(correlationId)` | Reassembling one request |
| `(eventType, occurredAt)` | Every alert in §8 |

The last one wasn't in the original list. Every alert filters on `eventType` and Postgres doesn't
index a foreign key on its own.

---

## 10. Commands, and what's left

```bash
pnpm db:deploy                              # apply the index migration
pnpm --filter @hitbox/audit test            # 98 tests, no database needed
pnpm --filter @hitbox/audit exec jest --verbose   # test names read as the spec
```

**Adding an event:** add a definition to `AUDIT_EVENT_CATALOG` with a severity and at least one
`sourceStories` citation (both asserted at import time — a duplicate or uncited event fails at boot),
re-run `seedAudit(prisma)`, then call `record()` or `emit()` from the module that does the action.

**Recording from a business module** — depend on the port, not the service:

```ts
import type { IAuditRecorder } from '@hitbox/audit';

await prisma.$transaction(async (tx) => {
    const assignment = await assignments.assign(input, tx);
    await audit.record({ eventType: 'role.assign', actor, result, organizationId,
        resource: { type: 'role', id: input.roleId }, afterState, metadata,
        correlationId: correlationIdOf(req) }, { tx });
});
```

Use `NOOP_AUDIT_RECORDER` in other modules' unit tests — never in a running server, since a silently
unaudited platform looks exactly like one where nothing happened.

### Still open

1. **No call sites.** The biggest gap. `role.*` and the DENIED results in
   `require-permission.middleware.ts` are the first targets; `access-control` is the only other
   module built far enough to take them.
2. **The three audit capabilities are granted to no role.** `audit-log:read:organization`,
   `:export:global`, `:manage:global` are in the permission catalog but on no `RoleDefinition` — who
   reads a tenant's trail, who exports, who shortens a window are policy calls. Add them to
   `role-catalog.ts` and re-run `pnpm db:seed:authz`.
3. **No step-up mechanism exists**, so export can't be mounted. A real gap, not just plumbing.
4. **Partitioning and the UPDATE/DELETE revoke aren't done** (§7).
5. **The keyset SQL isn't tested** — it needs a live Postgres. The services above it are covered.
6. **Only 13 of 20 CRITICAL events are pinned by test.**
7. **No rate limit on `/events`.** A reader can page the whole trail 200 rows at a time, and each
   page records only an `INFO`. The fix is a rate limit plus an alert on read volume per actor, not a
   heavier severity.
