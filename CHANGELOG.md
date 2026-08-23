# Changelog — NFC Verify & Claim feature

Spans both repos: **`hitbox-backend-monorepo`** (API + DB) and **`hitbox-static`** (Expo app).

## 2026-08-20 — RBAC authorization system (`packages/authz`)

Separated authentication from authorization across the platform. Clerk remains the
single identity provider for every frontend; the database is now the source of
truth for what an authenticated user may do.
Full docs: [`docs/authorization/`](docs/authorization/README.md).

### New module — `@hitbox/authz`
- **Permission model** `resource:action:scope` (`own` | `organization` | `any`),
  with a closed, typed catalog of resources and actions — a typo in a route is a
  compile error, not a silent deny.
- **Decision core** as pure functions (`domain/policy/scope-policy.ts`): the two
  checks are separate and both required —
  `hasPermission` (capability) and `isResourceAllowed` (this row).
  Grants are evaluated independently rather than collapsed to the widest scope,
  which is what makes multi-role users behave correctly.
- **Central service** `AuthorizationService` — `hasPermission`,
  `requirePermission`, `canAccessResource`, `requireResourceAccess`, `authorize`,
  `describe`. No role checks anywhere in business logic.
- **Route guard** `requirePermission(resource, action, { resource: loader })` —
  capability check, step-up gate, resource policy check and audit in one line.
- **List-endpoint support** `buildScopeFilter` + `scopeWhere` translate grants
  into a Prisma `where`; returns `null` (return nothing) rather than `{}` on a
  denial.
- **Tenancy** organizations + memberships; org-scoped grants are honoured only
  while an ACTIVE membership backs them, filtered in SQL.
- **Two-tier permission cache** in-process L1 + Redis L2, epoch-versioned, with
  targeted `DEL` + pub/sub invalidation and a TTL backstop. A cache outage
  degrades to reading Postgres, never to allowing.
- **Role administration** with six gates including no self-assignment, no
  vertical escalation (an ORG_ADMIN can never mint a platform admin), and
  lock-out protection on the last SUPER_ADMIN.
- **Audit log** append-only, with actor/action/resource/org/result/surface/metadata;
  sensitive capabilities are audited automatically from a catalog flag.
- **Step-up verification** for sensitive capabilities, using Clerk's `fva` claim.
  Fails closed.
- **SUPER_ADMIN** is enumerated into explicit permission rows — no wildcard
  short-circuit anywhere in the request path.

### Schema
- Migration `20260820120000_add_authorization_rbac` (purely additive): `permissions`,
  `roles`, `role_permissions`, `organizations`, `organization_memberships`,
  `user_role_assignments`, `audit_logs`, plus `products.organization_id`.
- Hand-added: two **partial** unique indexes on `user_role_assignments`, because
  Postgres treats NULLs as distinct and a plain unique constraint would not stop
  duplicate platform-wide grants.
- `users.role` is **deprecated, not dropped** — nothing reads it; removal is a
  separate migration (see `docs/authorization/12-operations.md`).

### `@hitbox/auth` — authentication only
- Removed `role` from `AuthContext` and `AccountSnapshot`; deleted the `UserRole`
  domain enum. A test now asserts no authorization data is on `req.auth`.
- Exposes Clerk's `fva` (factor verification age) claim for the step-up gate.

### Authorization applied to existing routes
- `products`: `POST /` → `product:create`; `PATCH /:id` and `DELETE /:id` →
  `product:update` / `product:delete` **plus** a resource policy check via a new
  two-column `findAuthorizationRef`. (Replaces the `requireAuth`-only TODO.)
- `users`, `collections`, `claims`: capability checks on every authenticated route.

### API surfaces — `apps/backend/src/surfaces/`
- Four surfaces so `hitbox.com`/mobile, `admin.hitbox.com` and
  `productmanager.hitbox.com` are distinguishable: per-surface CORS allowlists,
  per-surface rate-limit buckets, surface tagging on audit rows, and role
  administration simply not routable from customer clients.
- `public` + `app` stay mounted at the API root, so **every existing client path
  is unchanged**; admin is at `/api/v1/admin`, manage at `/api/v1/manage`.
- Replaced the global `origin: '*'` CORS with per-surface allowlists (falls back
  to the previous behaviour when unset, and warns in production).

### Frontend contract
- `GET /api/v1/authz/me` returns the permission manifest (roles, organizations,
  flat permissions, widest scope per capability) — for UX only; the backend
  re-checks every call.

### Tooling
- `pnpm authz:seed` reconciles the catalog, **diffs** role→permission links (so
  removing a permission in code actually revokes it), backfills the baseline
  `USER` role, and bumps the cache epoch. `--super-admin=<email>` bootstraps the
  first break-glass account.
- 98 new tests in `@hitbox/authz` covering the decision core, catalog invariants,
  caching/invalidation, all six escalation gates and the middleware end to end.
- `turbo.json` gained `typecheck`/`test`/`lint` tasks; root `pnpm typecheck`.

## 2026-07-24 — NFC tap-to-claim, end to end

### Backend — new `claims` module (`packages/claims`)
- New module: `constants`, `dto`, `repository`, `service`, `controller`, `module`, `index`, events.
- Endpoints:
  - `POST /api/v1/claim/:tagId` — single tap flow: claims if unclaimed, else returns the current owner ("already claimed by <name>"). Always `200`; only an unknown tag `404`s.
  - `GET /api/v1/verify/:tagId` — public authenticity + owner check.
  - `GET /api/v1/ledger/:tagId` — provenance chain.
- Ledger hash = `SHA-256(ProductID + TagId + OwnerId + DateTime)` (`domain/ledger-hash.ts`).
- "First Time" / HitBox origin ledger record auto-created on product creation via a `products.product.created` event subscriber.
- Peer-to-peer transfer was built early, then **removed** (out of scope for the demo).

### Backend — other modules & wiring
- `products`: added `findByTagId` + `getByTagId`, ownership `history`, routes `GET /products/tag/:tagId` and `/tag/:tagId/history`.
- Wired claims into `apps/backend/src/bootstrap.ts` and `routes.ts`; added `@hitbox/claims` + `@hitbox/auth` deps.

### Backend — Prisma / schema
- New enum `LedgerTxType { MINT, CLAIM, TRANSFER }`.
- `BlockchainLedger` gained `txType`, `sequenceNo` (unique per product), `previousHash`, `fromUser`/`toUser`.
- `User` back-relations `ledgerFrom` / `ledgerTo`.
- Migration `20260723120000_add_ledger_provenance_chain`; `seed.ts` updated to emit MINT→CLAIM chains with real hashes.

### Auth
- Added env-gated dev-auth (`X-Demo-User` header), then **replaced with real Clerk**; `DEMO_AUTH_ENABLED=false`. Verified: no token → `401`, so unauthenticated users cannot claim.

### Frontend app (`hitbox-static`)
- Installed/configured `react-native-nfc-manager` (app.json plugin + Android `NFC` permission).
- `src/lib/nfc.ts` (init, UID normalize, enable-prompt, tag listener), `src/lib/api.ts` (fetch client + token bridge + ngrok header).
- `src/features/nfc-claim/`: `api.ts`, `ScanScreen`, `ClaimScreen`, README.
- Routes `(routes)/scan.tsx`, `(routes)/claim/[tagId].tsx`; home "Scan NFC & Claim" button.
- Root layout: NFC enable-prompt + global tap → claim page.
- Clerk: `@clerk/clerk-expo` + `expo-secure-store`, `ClerkProvider` + SecureStore token cache, email/password sign-in wired in `EmailLogin`, claim gated on sign-in.

### Bugs fixed
- `.env` `NODE_ENV=developments` typo (server crashed on boot) → `development`.
- Claim `$transaction` timeout on remote Neon (5s too short) → raised to 20s + moved a query out of the transaction.

### Database (Neon)
- DB was `db push`-managed with no claims tables; baselined prior migrations and `db push`'d the schema (created `product_claims` + `blockchain_ledger` + new columns — additive).
- Provisioned + updated the demo product for tag `534A70C1610001` (name `Subratadaschip`, price `1000`, inventory `10`), reset to UNCLAIMED.

### Builds & infra
- Built debug + release APKs (release rebuilt with Clerk). Standalone release APK: `hitbox-static/android/app/build/outputs/apk/release/app-release.apk`.
- Ran backend (`:8000`) + ngrok tunnel (`ultra-coveting-payroll.ngrok-free.dev`).

### Testing
- E2E harness (`apps/backend/scripts/e2e.ts`) vs. throwaway embedded Postgres — 60/60 assertions passed (incl. recomputing the hash to prove the formula).
- Verified full flow against Neon with the real tag: claim → CLAIMED, re-tap → already-claimed-by-name, unknown tag → 404.

### NFC chip
- Store an NDEF URI record: `hitboxstatic://claim/534A70C1610001` (+ optional Android Application Record `com.subratadasdev1.hitboxstatic`).

### Scripts & docs
- Scripts: `provision-demo-tag.ts`, `reset-demo-tag.ts`, `inspect-demo-tag.ts`, `db-inventory.ts`, `update-demo-product.ts`.
- Docs: `docs/nfc-claim-verify-api.md`, `docs/nfc-api-e2e-test-report.md`, `docs/nfc-api-verification-status.md`, `docs/nfc-demo-setup.md`, `hitbox-static/src/features/nfc-claim/README.md`; updated `docs/hitbox-architecture.md`.

### Still open / temporary
- Sign-**up** (register) screens are UI-only — only sign-**in** is wired to Clerk.
- Email/password must be enabled in the Clerk dashboard; a user must exist.
- App's Discover/Marketplace/Collections tabs still render mock `.js` data (the NFC flow does not).
