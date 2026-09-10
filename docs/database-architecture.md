# HitBox Database Architecture

> How the platform database is decomposed across modules, why each table sits where it does, and
> how the pieces are stitched back into one PostgreSQL schema.
>
> **Scope:** the mobile platform domain (`DATABASE_URL`). The public website's lead-capture
> database (`LEADS_DATABASE_URL`, `@hitbox/leads`) is a separate database with a separate Prisma
> client — see [leads-schema.md](leads-schema.md). Nothing in this document touches it.
>
> Companion reading: [hitbox-architecture.md](hitbox-architecture.md) (application layering, ports,
> events) and [repo-structure.md](repo-structure.md) (the two-domain split).

---

## 1. The shape of it

**53 models. 46 enums. 96 foreign keys. 25 owning modules. One database, one migration history.**

The hybrid modular monolith rule applies to the schema exactly as it applies to the code: *the
schema is authored per module and merged for deployment.* No module edits a central schema file —
each owns a partial under `packages/<module>/prisma/`, and `merge-schema.mjs` stitches them into
the generated `packages/shared/database/prisma/schema.prisma`.

```text
  packages/shared/database/prisma/base.prisma      generator + datasource
  packages/shared/database/prisma/enums.prisma     cross-module enums only
  packages/<module>/prisma/<module>.prisma    ×25  the models that module OWNS
                          │
                          ▼   merge-schema.mjs  (deterministic order, rejects duplicates)
  packages/shared/database/prisma/schema.prisma    ⚠ GENERATED — never hand-edit
                          │
                          ▼   prisma migrate
                    PostgreSQL (Neon)
```

Why this is worth the indirection: a module's tables travel with the module. When `payments`
becomes its own service, its four models, four enums and the migration path for them are already
in one directory that nothing else writes to. The extraction cost is carving the tables out of the
shared database — not untangling them from a 2,000-line schema file that twelve teams edit.

---

## 2. Module ownership map

Every model has exactly one owning module. The merge script enforces this — a duplicate
`model`/`enum` declaration fails the build rather than silently letting the last one win.

| Module | Package | Models owned | What the module is responsible for |
|---|---|---|---|
| **Auth** | `@hitbox/auth` | `AuthWebhookEvent` | Clerk webhook intake + replay guard. Authentication only. |
| **Users** | `@hitbox/users` | `User`, `Address` | Local projection of the Clerk identity; the user's address book. |
| **Access control** | `@hitbox/access-control` | `Role`, `Permission`, `RolePermission`, `RoleAssignment` | Authorisation: who may do what, at what scope. |
| **Organizations** | `@hitbox/organizations` | `Organization` | The tenant root — HitBox, brands, artist-individuals. |
| **Artist** | `@hitbox/artist` | `Artist`, `ArtistCollection`, `ArtistBrandLink` | Creator identity, curated series, artist↔brand deals. |
| **Products** | `@hitbox/products` | `Product`, `ProductVariant`, `ProductImage`, `ProductPrice` | The catalog — what is for sale, in which options, at what price. |
| **Markets** | `@hitbox/markets` | `Market`, `MarketCountry` | Pricing/currency regions and country→market resolution. |
| **Releases** | `@hitbox/releases` | `ReleaseApproval` | The review workflow that gates `Product.status`. |
| **SKUs** | `@hitbox/skus` | `Sku` | The serialized-item registry: one row per physical collectible + its NFC tag. |
| **Claims** | `@hitbox/claims` | `ProductClaim`, `ProductHistory`, `BlockchainLedger` | Provenance — claiming, the ownership timeline, the hash chain. |
| **Collections** | `@hitbox/collections` | `BuyerCollection` | The buyer's shelf and its share/visibility rules. |
| **Media** | `@hitbox/media` | `MediaAsset` | The single upload registry for the whole platform. |
| **Content** | `@hitbox/content` | `ContentBundle`, `ContentBundleItem`, `ContentUnlock` | Exclusive content and the per-user grants that open it. |
| **Evolution** | `@hitbox/evolution` | `EvolutionRule`, `EvolutionEvent` | Collectibles that change as thresholds are crossed. |
| **Orders** | `@hitbox/orders` | `Order`, `OrderAddress`, `InventoryReservation` | The purchase record and the stock it holds. |
| **Payments** | `@hitbox/payments` | `PaymentTransaction`, `PaymentGatewayConfig`, `PaymentWebhookEvent`, `RefundRequest` | Everything that talks to a payment provider. |
| **Finance** | `@hitbox/finance` | `RoyaltyRule`, `RoyaltyLedgerEntry`, `FinanceLedgerEntry` | Royalty splits and the two append-only money ledgers. |
| **Notifications** | `@hitbox/notifications` | `NotificationTemplate`, `Notification`, `NotificationPreference` | Templated delivery + per-user channel opt-in. |
| **Social** | `@hitbox/social` | `Follow`, `WishlistItem` | Buyer intent signals feeding feeds and triggers. |
| **Resale** | `@hitbox/resale` | `ResaleListing` | The secondary market. |
| **Search** | `@hitbox/search` | `SearchIndexJob` | The transactional outbox feeding the search index. |
| **Audit** | `@hitbox/audit` | `AuditEventType`, `AuditEvent`, `AuditRetentionPolicy` | The compliance trail and its retention policy. |
| **Support** | `@hitbox/support` | `SupportCase` | Lost / damaged / stolen / cloned / disputed items. |
| **Supply** | `@hitbox/supply` | `Vendor`, `SupplyBatch` | The physical upstream: who made the tags, what arrived. |
| **Platform** | `@hitbox/platform` | `PlatformConfig` | Runtime config and feature flags. |

Two existing packages own **no** tables and are absent from this table by design: `@hitbox/discover`
and `@hitbox/marketplace` are read-side feeds that reach the catalog through injected ports, with no
`@hitbox/database` dependency at all. Keep it that way — a read model that grows its own table
stops being a read model.

---

## 3. The boundary decisions worth explaining

Most of the map above is obvious once you see it. These five splits are the ones a reader will
question, so here is the reasoning.

### 3.1 `Product` and `Sku` are different modules

`Product` is the *catalog definition* — "Ronin Vol. 1 hoodie, 500 units, ships in March". `Sku` is
*one physical object* — "#014 of 500, tag `04:A2:…`, owned by user X, tap counter 37".

They have opposite characteristics. The catalog is low-volume, edited by brand staff, and read
constantly by public feeds. The SKU registry is high-volume (one row per manufactured item), written
by tap/claim traffic, and is the most security-sensitive table on the platform — it carries tag
UIDs, one-shot claim tokens, and tamper state. Splitting them means catalog editing and item custody
scale, deploy and get audited independently, and the NFC attack surface lives behind one module's
service layer rather than inside the general product CRUD.

### 3.2 Provenance is three tables, not one

The claims module writes the same truth three ways, on purpose:

| Table | Question it answers | Access pattern |
|---|---|---|
| `ProductClaim` | "Who claimed this, when, under which drop?" | Written once per claim; read for receipts. |
| `ProductHistory` | "Who held this between March and July?" | Range-queried for timelines and analytics. |
| `BlockchainLedger` | "Prove none of the above was edited." | Append-only hash chain; verified, rarely queried. |

A single table cannot be simultaneously a fast timeline query, a normalised claim record, and a
tamper-evident chain. `BlockchainLedger` deliberately carries no useful query shape — each row
commits to its predecessor's hash, so any retroactive edit breaks the chain and is detectable, and
`@@unique([skuId, sequenceNo])` prevents a fork.

### 3.3 Order addresses are copied, not referenced

`OrderAddress` duplicates every address line rather than reading through `sourceAddressId`. That is
not denormalisation for speed — it is correctness. An order must always show where it was actually
sent, even after the buyer edits or archives that address book entry. `sourceAddressId` is kept as a
nullable provenance pointer only.

The same reasoning covers `Order.unitPrice`/`amount`/`currency`/`gateway`, `ProductClaim`'s
`artistId`/`collectionId`, and `AuditEvent.actorRoleSnapshot`: **anything that must remain true about
a past event is snapshotted, never joined.**

### 3.4 Both ledgers are append-only

`RoyaltyLedgerEntry` and `FinanceLedgerEntry` are never updated. A mistake is corrected by posting an
`ADJUSTMENT` entry that points at the original via `adjustsEntryId`, and a balance is the sum of the
rows. This is why `RoyaltyRule` is versioned by `effectiveFrom`/`effectiveTo` rather than mutable —
re-running an old order's royalties has to reproduce the original numbers.

Royalties and the platform ledger share one module because they are one reconciliation surface: a
royalty payable and the platform's own margin post against the same order in the same close.

### 3.5 The audit trail has no foreign keys

`AuditEvent.actorId`, `organizationId`, `resourceId` and `ledgerReferenceId` are all bare UUIDs. This
is deliberate on both directions of the relationship:

- The trail must stay **complete and readable** after the records it describes are archived or
  deleted — an audit log that loses rows to a cascade is not an audit log.
- The trail must **never be the reason a delete fails**. An FK from the audit table into every other
  table would make it exactly that.

`AuditEvent`'s primary key is composite — `@@id([eventId, occurredAt])` — so the table can be
range-partitioned by time for retention pruning while keeping per-event uniqueness.
`AuditEventType` is a *table* rather than an enum so new events register without a migration.

The same FK-free reasoning, for the same "must outlive its referent" reason, applies to
`Artist.complianceAttestedBy`, `PaymentTransaction.reviewedById`, `PlatformConfig.updatedById`,
`SupportCase.tagId`, `Sku.provisioningBatchId`, `Follow.followedOrganizationId`,
`SearchIndexJob.entityId` and `RoyaltyLedgerEntry.adjustsEntryId`.

---

## 4. Cross-module relations

Cross-module foreign keys work because Prisma sees one merged file. This is intentional coupling
**at the database layer only** — the application layer still goes through ports and events, and
carving a module's tables into their own database is a known step on the extraction path
([hitbox-architecture.md](hitbox-architecture.md) §11).

`User` is the hub, with 23 back-relations. Several models point at it twice, which Prisma requires
you to disambiguate with named relations:

| Model | Named relations to `User` | Why two |
|---|---|---|
| `RoleAssignment` | `User_user`, `User_grantedBy` | Separation of duties: the grantee is never the grantor. |
| `ReleaseApproval` | `User_approver`, `User_checkedBy` | Approval and compliance check are different sign-offs. |
| `RefundRequest` | `User_requestedBy`, `User_approvedBy` | Financial four-eyes: requester ≠ approver. |
| `SupportCase` | `User_reporter`, `User_resolvedBy` | Reporter is a buyer; resolver is staff. |

The other structural hubs are `Product` (12 back-relations), `Sku` (10) and `Organization` (9).

### Polymorphic pointers

Three places model "points at one of several things" without a foreign key:

- `Follow` — exactly one of `artistId` / `followedOrganizationId` is set. The two partial uniques
  work because Postgres treats `NULL`s as distinct, so a row with a null target never collides on
  that key.
- `SearchIndexJob` — `entityType` + `entityId` spans products, artists, collections and
  organizations; the indexer must not couple to any of their tables. `entityId` is null for
  `FULL_REINDEX`.
- `AuditEvent` — `resourceType` + `resourceId`, for the reasons in §3.5.

---

## 5. Enum ownership

**An enum lives in `shared/database/prisma/enums.prisma` only if two or more module partials
reference it.** A single-module enum lives in that module's own partial, so it travels with the
module on extraction. 41 of the 46 enums are single-module.

The five genuinely shared ones:

| Enum | Shared by |
|---|---|
| `Currency` | markets, orders, payments, finance, resale, claims |
| `PaymentGateway` | orders, payments |
| `Visibility` | users, collections |
| `ComplianceStatus` | products, releases |
| `AddressLabel` | users, orders |

`AddressUsage`, `LedgerEntryType` and `AuditSeverity` look shared but are not: each is referenced
only by models inside a single module, so they stay in `orders`, `finance` and `audit`
respectively. Check before promoting one — the default is *not* shared.

Note that `UserRole` (in the users partial) has a single member, `USER`. That is correct: it records
only that an account exists. **Every real privilege is a `RoleAssignment`** in the access-control
module, which is what lets one person hold several scoped roles at once — brand employee for org A,
buyer everywhere else.

---

## 6. Working with the schema

### Commands (run from the repo root)

| Command | What it does |
|---|---|
| `pnpm db:merge` | merge the 27 partials → `schema.prisma` |
| `pnpm db:validate` | merge + `prisma validate` |
| `pnpm db:generate` | merge + regenerate the Prisma client |
| `pnpm db:migrate` | merge + `prisma migrate dev` (create + apply a migration) |
| `pnpm db:deploy` | `prisma migrate deploy` (CI / production) |
| `pnpm db:studio` | Prisma Studio on the merged schema |

### Golden rules

1. **Never edit `schema.prisma`.** It is generated. Edit the module's partial, re-run `pnpm db:merge`.
2. **Never run `prisma migrate` against a partial.** Always go through the `db:*` scripts, which
   merge first.
3. **A model lives in exactly one partial.** The merge script fails the build on duplicates.
4. **An enum goes in `enums.prisma` only if 2+ modules use it** (§5).
5. **Import Prisma types from `@hitbox/database`**, never from `@prisma/client` directly.
6. **Only repositories touch Prisma.** Services and controllers never do
   ([hitbox-architecture.md](hitbox-architecture.md) §3).

### Adding a table to an existing module

Edit `packages/<module>/prisma/<module>.prisma`, then `pnpm db:migrate`. The merge picks it up
automatically — there is no registry to update.

### Adding a new module

```bash
mkdir -p packages/<name>/prisma packages/<name>/src
# copy package.json + tsconfig.json from a sibling, rename to @hitbox/<name>
# author packages/<name>/prisma/<name>.prisma
pnpm install && pnpm db:migrate
```

### Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** endpoint — runtime queries |
| `DIRECT_URL` | Neon **unpooled** endpoint — required by `prisma migrate` |

`base.prisma` declares both; Neon's pooler cannot run migrations, which is why the second one
exists. Both are already present in the root `.env`, which
`apps/backend/src/index.ts` loads before any other import.

---

## 7. Current state

Applied to Neon as two migrations — the baseline `20260910073121_init_hitbox_platform` and
`20260910101500_add_authorization_domain_and_scopes` (the RBAC additions, see
[authorization-architecture.md](authorization-architecture.md) §2):

- **54 tables** (53 models + `_prisma_migrations`)
- **46 enum types**
- **96 foreign key constraints**

The previous four migrations described the earlier, much smaller schema and were removed when this
baseline replaced it. They remain in git history and can be recovered from there if ever needed.

### Known gaps

These are deliberate records of what the schema does *not* yet do, not a backlog someone forgot.

1. **No `@default` / `@updatedAt` anywhere.** Every `id`, `createdAt` and `updatedAt` must be
   supplied by the application on write. This is a valid choice (it keeps id generation and clock
   authority in one place, useful when a module later moves to its own service), but it is a
   deviation from the rest of the repo, and every repository has to honour it. Adding
   `@default(uuid())`, `@default(now())` and `@updatedAt` is a non-destructive migration if the
   convention changes.

2. **No secondary indexes.** Postgres does **not** auto-index foreign keys, and there are 96 of
   them. `@@unique` constraints are indexed; nothing else is. Expect to add `@@index` on the hot FK
   columns before load matters — `Sku.productId`/`ownerId`, `Order.buyerId`/`status`,
   `AuditEvent.correlationId`/`occurredAt`, `ProductHistory.skuId` + `isCurrent`,
   `SearchIndexJob.status`, `Notification.userId` + `status`.

3. **No `@map` / `@@map`.** Table and column names are the Prisma defaults (`ProductClaim`,
   `createdAt`) rather than the snake_case (`product_claims`, `created_at`) the earlier schema used.
   Renaming later is a mechanical but genuinely destructive migration, so decide now if it matters.

4. **`PermissionScope` was added during this decomposition, then extended.** `Permission.scope`
   referenced it and `@@unique([resource, action, scope])` depended on it, but the enum was never
   declared — the schema could not compile. It now carries
   `GLOBAL | ORGANIZATION | OWN | PUBLIC | MASKED | MASKED_PARTIAL`; the three masking values
   encode the PII visibility levels the RBAC work needed. `RoleScopeType`'s `ORG` member was
   renamed `ORGANIZATION` at the same time so both enums, the permission-key strings and the
   requirements matrix share one word. See
   [authorization-architecture.md](authorization-architecture.md) §3.

5. **No `onDelete` behaviour is declared** on any relation, so every FK uses Prisma's default
   (`Restrict` for required relations, `SetNull` for optional). That is a safe default — nothing
   cascades unexpectedly — but it means deleting a `User` will fail while any order, claim or SKU
   references them. Soft delete via the `archivedAt` / `deactivatedAt` / `isActive` columns is the
   intended path, and the FK-free audit and ledger tables are what make it safe.

6. **Application code has not been updated.** The 25 partials define the DB layer only; module
   service/repository/controller layers are not built, and the existing `auth`, `users`, `products`,
   `artist`, `claims` and `collections` code still targets the previous schema. The seed and
   demo-tag scripts under `packages/shared/database/prisma/` reference removed models and will not
   run as written.
