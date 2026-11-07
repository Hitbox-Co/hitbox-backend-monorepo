# Changelog — NFC Verify & Claim feature

Spans both repos: **`hitbox-backend-monorepo`** (API + DB) and **`hitbox-static`** (Expo app).

## 2026-09-29 — US-P018 Claim Integrity Controls

Closed the two acceptance criteria that were still open: a replayed confirm is
now rejected, and the loser of a simultaneous tap is told it *just* lost.

### The replay hole this closes
A captured `confirm` request was replayable. Harmless while the item stayed
claimed — but `revokeClaim()` returns a refunded unit to `UNCLAIMED`, and at
that moment the captured request worked again and the refunded buyer re-owned
the item.

### Backend — `packages/claims`
- **New `ClaimToken` table** (`prisma/claims.prisma`): one row per issuance,
  `tokenHash` (SHA-256, unique) / `skuId` / `userId` / `status` /
  `issuedAt` / `expiresAt` / `consumedAt` / `claimId` / `replayCount` /
  `lastReplayAt` / `requestId`, plus enum
  `ClaimTokenStatus { ISSUED, CONSUMED, LOST_TIEBREAK, SUPERSEDED, EXPIRED }`.
  A table rather than `Sku.claimToken` because one column holds one token, so
  two simultaneous taps overwrote each other's.
- `Sku.claimToken*` marked `@deprecated`; columns kept, and
  `claimTokenUsedAt` is still stamped by the claim transaction.
- **New `domain/claim-token.ts`** — `generateClaimToken()` (32 random bytes,
  base64url), `hashClaimToken()`, `ClaimTokenRejectedError`,
  `CLAIM_TOKEN_TTL_SECONDS = 120`.
- **Validate** (`POST /claims/:tagId`) now issues a token on the `CLAIMABLE`
  screen and returns `claimToken` + `claimTokenExpiresAt`; both `null` on the
  other two screens. Re-validating supersedes that user's previous token and
  leaves anyone else's alone.
- **Confirm** (`POST /claims/:tagId/confirm`) accepts `claimToken` in the body
  (still `.strict()`). Inside the one existing transaction, in order: burn the
  token with a compare-and-swap → SKU tiebreak → the existing writes → set
  `ClaimToken.claimId`. Token first, so a replay changes nothing before it is
  refused. The early `if (CLAIMED) return` in `claim()` is gone — it was what
  let a replay skip the token check entirely.
- **New outcome `CLAIMED_BY_OTHER_JUST_NOW`** (`200`) for the losing half of a
  simultaneous tap, with the winner as `owner` and `claim: null`. An item
  claimed earlier still returns `ALREADY_CLAIMED`; the discriminator is the
  item's status as read at the start of the request.
- **New error codes**: `CLAIMS_TOKEN_REUSED` (409), `CLAIMS_TOKEN_EXPIRED`
  (410), `CLAIMS_TOKEN_INVALID` (400). The sub-reason is logged, never
  returned.
- **New events**: `claims.token.rejected`, `claims.tiebreak.lost`, each with a
  structured log line carrying a `metric` field.
- **Rollout flag `CLAIM_TOKEN_REQUIRED`** (env, default `false`). Off, a
  missing token is the old behaviour plus `metric: claims.token.missing`; on,
  it is a 400. A token that *is* sent is always checked in full, and the race
  outcome applies either way.
- **Tests**: `packages/claims` gains a jest setup and 26 tests, including a
  20-run simultaneous-tap race. They run against an in-memory Prisma double
  with real rollback semantics — see `tests/fake-prisma.ts` for what that
  proves and what still needs a real Postgres.

### Prisma
- Migration `20260929140000_claim_tokens` — purely additive (one enum, one
  table, four indexes, two FKs).

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
