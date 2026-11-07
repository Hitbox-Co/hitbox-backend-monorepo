# Build prompt — US-P018 Claim Integrity Controls

> Copy everything below the line into Claude Code (or any coding agent) opened at the root of `hitbox-backend-monorepo`.

---

## Your task

Implement **US-P018 — Claim Integrity Controls: Single-Use Claim Token + Simultaneous-Tap Tiebreak** in the `@hitbox/claims` package of this pnpm/turbo monorepo (Express + Prisma + PostgreSQL on Neon, auth via Clerk).

Read this whole prompt before writing code. Then read the files listed in "Read first". Make a short plan, then build it in the order given under "Build steps". Don't skip the tests.

### The user story (source of truth)

As the platform, I need the claim endpoint to do two things:

- Reject a replayed claim request.
- Settle two near-simultaneous taps on the same tag the same way every time.

That way only one valid claim is ever recorded per item.

**Acceptance criteria:**

1. A replayed claim request with an already-used token is rejected and does **not** create a second `SkuClaim`.
2. Two near-simultaneous claim requests on the same tag end in **exactly one** successful claim.
3. The losing request gets an explicit "this item was just claimed by someone else" response. It must not be a generic failure.
4. The token is created on the server when the tap starts (the validate step). It has a short time-to-live (TTL), works once, and is checked and used up atomically.
5. The tiebreak decision and the `SkuClaim` write happen in **the same database transaction**. No later reconciliation job fixes double-claims.
6. The token and its state (issued, used or expired) are recorded for audit.
7. Analytics count two things: rejected replay attempts and lost tiebreaks.
8. All of this is **in addition to** the existing rate limiting. Don't remove or replace it.

---

## What already exists (don't rebuild it)

Read first:

- `packages/claims/src/service/claims.service.ts`: `validate()`, `claim()`, `revokeClaim()`
- `packages/claims/src/repository/claims.repository.ts`: `claimByTag()` (the claim transaction) and `revokeClaim()`
- `packages/claims/src/controller/claims.controller.ts`
- `packages/claims/src/dto/claims.dto.ts`: `claimBodySchema` is `.strict()` and allows only `visibility`
- `packages/claims/src/constants/claims.constant.ts`
- `packages/claims/src/module.ts`
- `packages/claims/prisma/claims.prisma`
- `packages/skus/prisma/skus.prisma`: `Sku.claimToken`, `claimTokenIssuedAt`, `claimTokenUsedAt`
- `packages/skus/src/repository/sku.repository.ts` and `packages/skus/src/domain/sku-update.ts`: they state `claimToken` is never selected or returned by the admin SKU API
- `apps/backend/src/app.ts`: the global `/api/v1` rate limiter
- `apps/backend/src/bootstrap.ts`
- `docs/nfc-claim-verify-api.md`
- `docs/database-architecture.md`: partial-schema ownership rules
- `packages/shared/errors/app-error.ts`: `AppError.badRequest / conflict / ...`
- `packages/skus/jest.config.cjs` and `packages/skus/tests/*`: the test setup pattern to copy

The routes are live under `/api/v1`:

| Route | Auth | What it does today |
|---|---|---|
| `POST /claims/:tagId` | yes | **Validate.** Returns `screen: CLAIMABLE / ALREADY_CLAIMED_BY_YOU / ALREADY_CLAIMED`. Doesn't change anything. |
| `POST /claims/:tagId/confirm` | yes | **Claim.** Returns 200 with `outcome: CLAIMED / ALREADY_CLAIMED`. |
| `GET /verify/:tagId` | public | Authenticity and owner check |
| `GET /ledger/:tagId` | public | Hash-chain provenance |

**Already done — keep it working:**

- **Tiebreak core.** Inside `claimByTag()`, `tx.sku.updateMany({ where: { id, claimedStatus: 'UNCLAIMED' } ... })` is a compare-and-swap. If `count === 0`, the transaction returns `null` and the service reports whoever won. `@@unique([skuId, claimedNo])` on `SkuClaim` is a second safety net. Keep both.
- **Rate limiting.** There is only a global per-IP limiter on `/api/v1` (`createRateLimiter()` in `app.ts`, Redis-backed when `REDIS_URL` is set). There's no limiter specific to the claim endpoint.

**What is missing (your job):**

- No claim token is ever created, returned or checked. The `Sku.claimToken*` columns exist but are unused. `claimTokenUsedAt` is only stamped at claim time.
- The losing side of a race gets the same `ALREADY_CLAIMED` answer as an item claimed weeks ago.
- No audit record of token state, and no counters for replays or tiebreaks. The lost-race path isn't even logged.
- The claims package has no tests.
- **Security gap to close:** after `revokeClaim()` sets a SKU back to `UNCLAIMED` (after a refund), a captured confirm request can claim it again, because nothing ties a confirm request to a single tap.

---

## Design decisions (follow these; if you disagree, say why before changing them)

### D1. Store tokens in a new companion table, not in `Sku.claimToken`

`Sku.claimToken` holds **one** token per item. If two people tap the same item at once, the second validate would overwrite the first person's token. The first person would then fail with "invalid token" instead of the correct "just claimed by someone else", which breaks acceptance criterion 3. It also keeps no history, so it can't meet criterion 6.

So add a new model **`ClaimToken`** to the claims module's partial, `packages/claims/prisma/claims.prisma`. **Never edit the generated `schema.prisma`.**

```prisma
/// One row per validate tap that was eligible to claim. Single-use proof that
/// a confirm request belongs to a specific, recent tap by a specific user.
/// Also the audit and analytics record for replay and tiebreak events.
model ClaimToken {
  id          String           @id @default(uuid(7)) @db.Uuid
  /// SHA-256 (hex) of the raw token. The raw token is returned to the client
  /// once and never stored, so a database leak can't be replayed.
  tokenHash   String           @unique @db.Char(64)
  skuId       String           @db.Uuid
  sku         Sku              @relation(fields: [skuId], references: [id])
  /// The user the token was issued to. A different user can't use it.
  userId      String           @db.Uuid
  user        User             @relation(fields: [userId], references: [id])
  status      ClaimTokenStatus @default(ISSUED)
  issuedAt    DateTime         @default(now())
  expiresAt   DateTime
  /// Set exactly once, by the compare-and-swap in the claim transaction.
  consumedAt  DateTime?
  /// The SkuClaim this token produced when it won. Plain id, no FK, same
  /// reasoning as the other provenance pointers in this module.
  claimId     String?          @db.Uuid
  /// How many times someone tried to use this token after it was used or expired.
  replayCount Int              @default(0)
  lastReplayAt DateTime?
  /// Correlates with request logs.
  requestId   String?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@index([skuId, issuedAt])
  @@index([userId, skuId, status])
  @@index([status, issuedAt])
}

enum ClaimTokenStatus {
  ISSUED          // live, not yet used
  CONSUMED        // used by the winning confirm
  LOST_TIEBREAK   // used by a confirm that lost the race
  SUPERSEDED      // replaced by a newer validate from the same user on the same SKU
  EXPIRED         // TTL passed without use (set lazily when someone tries it)
}
```

- Add the back-relations `claimTokens ClaimToken[]` to `Sku` (in `packages/skus/prisma/skus.prisma`) and to `User` (in `packages/users/prisma/users.prisma`). Put them in the "cross-module back-relations" blocks, the way other modules do.
- Leave the existing `Sku.claimToken` / `claimTokenIssuedAt` columns alone and don't write to them. Add a `/// @deprecated — superseded by ClaimToken (US-P018); do not use` doc comment, matching the deprecation style already used on `Sku`. Keep stamping `claimTokenUsedAt` in `claimByTag()` as it does today, so nothing that reads it breaks.
- Create the migration with `pnpm db:migrate:create`. It runs merge-schema first. Name it `<timestamp>_claim_tokens`. It should only add things (a new table and enum, no destructive changes). Then run `pnpm db:generate`.

### D2. The token itself

- Generate it with `crypto.randomBytes(32).toString('base64url')` (43 characters). Store `sha256(token)` as hex in `tokenHash`.
- TTL is **120 seconds** by default. Put it in `claims.constant.ts` as `CLAIM_TOKEN_TTL_SECONDS`. Let it be overridden by an env var if `packages/shared/config/env.ts` follows that pattern for module tunables. Check how the file does it.
- The token is bound to **(skuId, userId)**. A confirm is valid only when the token hash matches, the SKU matches the `:tagId`, the user matches `req.auth.accountId`, `consumedAt IS NULL`, `status = ISSUED` and `expiresAt > now()`.

### D3. Validate issues the token

In `ClaimsService.validate()`:

- Only when `screen === 'CLAIMABLE'`:
  1. Mark any live `ISSUED` tokens for the same (userId, skuId) as `SUPERSEDED`. A user re-tapping gets a fresh token, and the old one can't be kept for later.
  2. Insert a new `ClaimToken`.
  3. Add `claimToken: string` and `claimTokenExpiresAt: string` (ISO format) to `ValidateResult`.
- For the other two screens, return `claimToken: null` and `claimTokenExpiresAt: null`.
- Put the database writes in the repository, not the service (the repository is "the only place in this module that touches Prisma").

### D4. Confirm uses up the token and applies the tiebreak in ONE transaction

Change `claimBodySchema` to:

```ts
z.object({
  claimToken: z.string().trim().min(20).max(128),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
}).strict()
```

Rewrite the flow in `ClaimsService.claim()` and `ClaimsRepository.claimByTag()` so this happens inside **one** `prisma.$transaction`, in this order:

1. **Use up the token (compare-and-swap):**
   ```ts
   tx.claimToken.updateMany({
     where: { tokenHash, skuId: sku.id, userId, status: 'ISSUED', consumedAt: null, expiresAt: { gt: now } },
     data:  { consumedAt: now, status: 'CONSUMED' },
   })
   ```
   If `count === 0`, **throw** a typed `ClaimTokenRejectedError` from inside the transaction so everything rolls back. Work out the reason by reading the row by `tokenHash`:
   - no row, or `skuId` / `userId` don't match → `INVALID`
   - `consumedAt` is set, or status is `CONSUMED` / `LOST_TIEBREAK` / `SUPERSEDED` → `REUSED`
   - `expiresAt <= now` → `EXPIRED`
2. **Tiebreak (compare-and-swap on the SKU):** use the existing `tx.sku.updateMany({ where: { id, claimedStatus: 'UNCLAIMED' } })`.
   - If `count === 0`, **this request lost the race.** Update the token to `status: 'LOST_TIEBREAK'` and **commit** (return `{ lost: true }`, don't throw). The token is still used up, because it's single-use whether it won or lost.
3. **Winner path:** keep the existing writes unchanged: `SkuClaim`, `BlockchainLedger` MINT/CLAIM, `SkuHistory`, `BuyerCollection`. Then set `claimToken.claimId = claim.id`.

Why the token check comes before the SKU check: if it came after, a replayed request against an unclaimed SKU would flip the SKU before the token was checked. Throwing on a bad token keeps the SKU untouched.

Remove the early `if (sku.claimedStatus === 'CLAIMED') return alreadyClaimed(...)` fast path at the top of `claim()`, **or** move it after token verification. Otherwise, replaying a used token against a claimed item returns a friendly 200 instead of being rejected, which breaks criterion 1.

Outside the transaction, after a `ClaimTokenRejectedError`: increment `replayCount` / `lastReplayAt` on the token row (when the row exists) and, if the reason is `EXPIRED`, set `status = 'EXPIRED'`. Use a separate small write that is allowed to fail: log the error and don't rethrow. Then emit the analytics described in D6, and send the error response described in D5.

The claim-code collision retry loop that already exists (`CLAIM_CODE_MAX_ATTEMPTS`) must still work. A retry can happen after the token was used up in a rolled-back attempt. Because the rollback undoes the token update too, the retry sees the token as `ISSUED` again. Check that this is actually true and cover it with a test.

### D5. Responses (the API contract)

Keep the existing contract (200 + `outcome`) for business outcomes, and use HTTP errors for invalid requests.

| Situation | HTTP | Body |
|---|---|---|
| Won | 200 | `outcome: 'CLAIMED'` (unchanged) |
| **Lost the simultaneous-tap race** | 200 | **new** `outcome: 'CLAIMED_BY_OTHER_JUST_NOW'`, `claimedByYou: false`, `message: 'This item was just claimed by someone else.'`, `owner` = the winner (re-read the SKU), `claim: null` |
| Token already used (replay) | 409 | `AppError.conflict('This claim link has already been used. Tap the item again.', 'CLAIMS_TOKEN_REUSED')` |
| Token expired | 410 if `AppError` supports it, otherwise 409 | code `CLAIMS_TOKEN_EXPIRED`, message "This tap has expired. Tap the item again." |
| Token missing, malformed, or for another user or SKU | 400 | code `CLAIMS_TOKEN_INVALID` |
| Tag not registered | 404 | unchanged `CLAIMS_TAG_NOT_FOUND` |

- Add the new error codes to `CLAIMS_ERROR_CODES` and the new outcome to `CLAIM_OUTCOME` and to the `ClaimFlowResult['outcome']` union.
- Don't expose which of the INVALID sub-reasons applied (wrong user versus unknown token). Log it on the server only.

### D6. Audit and analytics

- **Audit:** the `ClaimToken` table is the audit trail. Every issue, use, lost race, supersede and replay is visible on a row. Also look at how other modules write `AuditEvent`s: search for the audit writer interface and `packages/shared/database/prisma/seed-audit.ts`. If there is a pattern for modules to emit audit events, register and emit `claim.token_rejected` (severity WARNING) and `claim.tiebreak_lost` (severity INFO). Don't invent a new audit mechanism.
- **Analytics:** publish two events on the existing `eventBus`, and add their names to `CLAIMS_EVENTS` and their payload types to `events/claims-event.payloads.ts`:
  - `claims.token.rejected`: `{ skuId, userId, reason: 'INVALID' | 'REUSED' | 'EXPIRED', tokenId | null, at }`
  - `claims.tiebreak.lost`: `{ skuId, loserUserId, winnerUserId, tokenId, at }`
- Also write one structured `logger.info` / `logger.warn` line per event with a stable `metric` field (`metric: 'claims.token.rejected'`), so the numbers can be counted from logs even without a subscriber.
- **Optional, only if quick:** a read-only admin query that returns counts by `ClaimToken.status` and by rejection reason over a date range. Use the existing access-control guard pattern for admin routes. Skip it if it gets complicated, and say so in your summary.

### D7. Staged rollout (the mobile app must change too)

Requiring `claimToken` on confirm is a **breaking change** for the mobile app. Add a feature flag, `CLAIM_TOKEN_REQUIRED`. Use `PlatformConfig` if there's an existing reader for feature flags; otherwise use an env var in `env.ts`. Default it to `false` in dev and document it.

- **Flag off:** `claimToken` is optional. If present, fully check and use it. If absent, fall back to today's behaviour and log `metric: 'claims.token.missing'`.
- **Flag on:** `claimToken` is required (400 `CLAIMS_TOKEN_INVALID` if missing).
- The tiebreak outcome (`CLAIMED_BY_OTHER_JUST_NOW`) applies in both modes.

### D8. Rate limiting (additive)

Don't touch the global limiter. Add a tighter per-IP limiter just on `POST /claims/:tagId/confirm` and `POST /claims/:tagId` inside `module.ts`, using `createRateLimiter({ prefix: 'claims', windowMs: 60_000, max: 30 })` from `@hitbox/shared`, only if this doesn't break existing app behaviour. Document it. This is optional hardening; mention in your summary whether you added it.

---

## Build steps (in this order)

1. **Schema:** add `ClaimToken` and `ClaimTokenStatus` to `claims.prisma`, the back-relations on `Sku` and `User`, and the deprecation comments on `Sku.claimToken*`. Run `pnpm db:merge`, `pnpm db:validate`, `pnpm db:migrate:create` (name `claim_tokens`), then `pnpm db:generate`. Show the generated SQL and confirm it only adds things.
2. **Constants and DTOs:** TTL, error codes, the new outcome, event names, and the updated `claimBodySchema` and `ValidateResult` / `ClaimFlowResult`.
3. **Domain helper:** `packages/claims/src/domain/claim-token.ts` with `generateClaimToken()`, `hashClaimToken()` and `ClaimTokenRejectedError`. Keep these pure so they're easy to test.
4. **Repository:** `issueClaimToken()` (supersede old tokens, insert the new one), a new `claimByTag()` with the token compare-and-swap followed by the SKU compare-and-swap in one transaction, and `recordTokenRejection()`.
5. **Service:** update `validate()` and `claim()` per D3–D5, emit the analytics per D6, and respect the flag per D7.
6. **Controller and module:** pass `req.id` / the request id into the service if there's a request-id middleware. Add the optional route limiter (D8).
7. **Tests:** add `jest.config.cjs`, `tsconfig.jest.json`, `tests/setup.ts` and a `"test": "jest"` script to `packages/claims`, copied from `packages/skus`. Write:
   - **Unit tests** (mocked repository): token generation and hashing, reason mapping, and each response in the D5 table.
   - **Transaction tests:** run against a real Postgres if the repo has a test-DB convention (look for one). Otherwise use a mocked `$transaction` that runs the callback, and state clearly that the race test needs a real DB.
     - a. Valid token → CLAIMED, exactly one `SkuClaim`, token `CONSUMED` with `claimId` set.
     - b. The same request sent again → 409 `CLAIMS_TOKEN_REUSED`, still exactly one `SkuClaim`, `replayCount = 1`.
     - c. Expired token → `CLAIMS_TOKEN_EXPIRED`, no `SkuClaim`, SKU still `UNCLAIMED`.
     - d. Token issued to user A, confirm sent by user B → 400 `CLAIMS_TOKEN_INVALID`.
     - e. Token for SKU 1 used against SKU 2's tag → 400 `CLAIMS_TOKEN_INVALID`.
     - f. **Race:** two users validate the same SKU, then both confirm through `Promise.all` → exactly one `CLAIMED`, one `CLAIMED_BY_OTHER_JUST_NOW`, exactly one `SkuClaim`, and the loser's token is `LOST_TIEBREAK`. Repeat 20 times.
     - g. Re-validating supersedes the previous token → the old token gives `REUSED`/`INVALID` and the new one works.
     - h. **Revocation replay:** claim, `revokeClaim()` (SKU goes back to `UNCLAIMED`), then replay the original confirm → rejected, and the SKU stays `UNCLAIMED`.
     - i. Claim-code collision retry still succeeds with the same token.
     - j. Flag off and no token → the legacy path still claims (and logs `claims.token.missing`).
8. **Docs:** update `docs/nfc-claim-verify-api.md`: the new `claimToken` fields on validate, the confirm body, the new outcome, the error codes, the flag, and new curl examples for the replay and race flows. Add a CHANGELOG entry. Note in `docs/schema-v3.1-changes.md` (or the current schema changelog) that `Sku.claimToken*` is replaced by `ClaimToken`.
9. **Check:** run the claims package typecheck, the new tests, and the skus tests, so nothing else breaks. Report the results.

## Rules

- Follow the existing code style: service / repository / controller split, Zod DTOs, `AppError`, `asyncHandler`, long `///` doc comments explaining *why*, 4-space indent.
- Only the repository touches Prisma.
- Edit schema **partials**, never the generated `schema.prisma`.
- Don't return the raw token anywhere except the validate response. Don't log it; log the token id or the first 8 characters of the hash.
- Don't change `revokeClaim()` behaviour, the ledger hash format, or the `verify` / `ledger` endpoints.
- Nothing destructive in the migration.

## When you're done, reply with

1. The files you changed or added.
2. The migration SQL.
3. The test results (pass or fail counts) and which tests need a real database.
4. Any design decision you changed and why.
5. What the mobile app team must change: send `claimToken` from the validate response to confirm, handle `CLAIMED_BY_OTHER_JUST_NOW`, and on 409/410 re-run validate.
