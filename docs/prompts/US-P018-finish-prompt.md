# Prompt: finish US-P018 (claim token + explicit "just claimed" response)

Paste everything below into Claude Code, opened at the root of `hitbox-backend-monorepo`.

---

## Goal

Finish **US-P018 — Claim Integrity Controls** in `packages/claims`. Two acceptance criteria are not met yet:

1. **A replayed claim request using an already-used token must be rejected and must not create a second `SkuClaim`.**
   Not met: no token exists, so nothing can be "already used".
3. **The losing request of a simultaneous tap must get an explicit "already claimed" response.**
   Partly met: the loser gets the same `ALREADY_CLAIMED` reply as an item claimed weeks ago.

Criterion 2 (two simultaneous taps give exactly one claim) is **already built**. Keep it working and don't rewrite it.

## What exists today (read these first)

- `packages/claims/src/service/claims.service.ts`: `validate()` and `claim()`
- `packages/claims/src/repository/claims.repository.ts`: `claimByTag()` runs one transaction. It flips the SKU with `updateMany where claimedStatus 'UNCLAIMED'`, and returns `null` if it lost.
- `packages/claims/src/dto/claims.dto.ts`: `claimBodySchema` is `.strict()` and only allows `visibility`
- `packages/claims/src/constants/claims.constant.ts`, `events/claims-event.payloads.ts`, `module.ts`, `controller/claims.controller.ts`
- `packages/claims/prisma/claims.prisma`; `Sku.claimToken*` columns in `packages/skus/prisma/skus.prisma` (unused)
- `packages/shared/errors/app-error.ts`
- `packages/skus/jest.config.cjs` and `tests/`: the test pattern to copy

Routes: `POST /api/v1/claims/:tagId` (validate) and `POST /api/v1/claims/:tagId/confirm` (claim).

## The problems, with where they are

| Problem | Where |
|---|---|
| No token is created or checked | `validate()` and `claim()` in `claims.service.ts` |
| Confirm body has no token field | `claimBodySchema` in `claims.dto.ts` |
| `claim()` returns early with a friendly `ALREADY_CLAIMED` if the item is claimed. So a used token is never rejected. After `revokeClaim()` resets the item to UNCLAIMED, a captured request can claim it again. | Top of `claim()` |
| The loser of a race gets a generic `ALREADY_CLAIMED` | The `if (!result)` branch in `claim()` |
| No record of token state for audit or debugging | No table exists |
| No counts of replays or lost races | Nothing is emitted or logged |
| The `claims` package has no tests | `packages/claims` |

## What to build (in this order)

### 1. `ClaimToken` table (new model in `packages/claims/prisma/claims.prisma`)

Don't use `Sku.claimToken`. It holds one token per item, so two simultaneous taps would overwrite each other's token. Add a new model instead:

- `id` (uuid7), `tokenHash` (unique, char 64; store the SHA-256 of the token, never the raw token)
- `skuId` and `userId` (relations to `Sku` and `User`; add back-relations in the skus and users partials)
- `status`: `ISSUED | CONSUMED | LOST_TIEBREAK | SUPERSEDED | EXPIRED`
- `issuedAt`, `expiresAt`, `consumedAt?`, `claimId?` (plain id, no FK), `replayCount` (default 0), `lastReplayAt?`, `requestId?`
- Indexes on `(skuId, issuedAt)`, `(userId, skuId, status)`, `(status, issuedAt)`

Edit the **partials only**, never the generated `schema.prisma`. Then run `pnpm db:merge`, `pnpm db:migrate:create` (name it `claim_tokens`) and `pnpm db:generate`. The migration must only add things. Mark `Sku.claimToken*` as `@deprecated`, but don't drop the columns. Keep `claimTokenUsedAt` being stamped in `claimByTag()`.

### 2. Token helpers (new file `domain/claim-token.ts`)

- `generateClaimToken()`: `randomBytes(32).toString('base64url')`
- `hashClaimToken()`: SHA-256 hex
- `ClaimTokenRejectedError` with reason `INVALID | REUSED | EXPIRED`
- TTL constant `CLAIM_TOKEN_TTL_SECONDS = 120`

### 3. Validate issues the token (`validate()` + repository `issueClaimToken()`)

Only when `screen === 'CLAIMABLE'`:
- Mark the same user's live `ISSUED` tokens for that item as `SUPERSEDED`.
- Insert a new token and return `claimToken` and `claimTokenExpiresAt` in `ValidateResult`.
- On the other two screens, return both as `null`.

### 4. Confirm uses the token and applies the tiebreak in ONE transaction

Add `claimToken` to `claimBodySchema` (still `.strict()`). Inside the single `prisma.$transaction` in `claimByTag()`, in this order:

1. **Use the token (compare-and-swap):** `tx.claimToken.updateMany({ where: { tokenHash, skuId, userId, status:'ISSUED', consumedAt:null, expiresAt:{ gt: now } }, data:{ consumedAt: now, status:'CONSUMED' } })`. If `count === 0`, throw `ClaimTokenRejectedError` so the whole transaction rolls back. Work out the reason by reading the token row:
   - no row, or wrong user or item → `INVALID`
   - already consumed, lost, or superseded → `REUSED`
   - expired → `EXPIRED`
2. **Tiebreak:** keep the existing SKU `updateMany ... 'UNCLAIMED'`. If `count === 0`, set the token to `LOST_TIEBREAK`, **commit** (don't throw), and return `{ lost: true }`. A lost tap still uses up its token.
3. **Winner:** keep all existing writes (`SkuClaim`, ledger, history, collection) and set `claimToken.claimId`.

The token check must come **before** the SKU check. Otherwise a replayed request could change the item before its token is rejected.

In `claim()`, remove the early `if (sku.claimedStatus === 'CLAIMED') return ...` return, or move it after the token check.

After a `ClaimTokenRejectedError`, outside the transaction, do a best-effort update: increment `replayCount` and `lastReplayAt`, and set `EXPIRED` if that was the reason. If that update fails, log it and carry on.

The existing claim-code collision retry loop must still work. A rolled-back attempt also rolls back the token update, so the retry sees the token as `ISSUED`. Write a test for this.

### 5. Responses

| Situation | HTTP | Result |
|---|---|---|
| Won | 200 | `outcome: CLAIMED` (unchanged) |
| **Lost the race** | 200 | New `outcome: CLAIMED_BY_OTHER_JUST_NOW`, `claimedByYou:false`, `message: "This item was just claimed by someone else."`, the winner as `owner`, `claim: null` |
| Token already used | 409 | `CLAIMS_TOKEN_REUSED` — "This claim link has already been used. Tap the item again." |
| Token expired | 410 (or 409 if `AppError` has no 410) | `CLAIMS_TOKEN_EXPIRED` |
| Token missing, malformed, wrong user or item | 400 | `CLAIMS_TOKEN_INVALID` (log the sub-reason, don't return it) |

Add the new codes to `CLAIMS_ERROR_CODES`, the new value to `CLAIM_OUTCOME`, and the `ClaimFlowResult['outcome']` type.

### 6. Analytics and audit

- Publish `claims.token.rejected` `{ skuId, userId, reason, tokenId|null, at }` and `claims.tiebreak.lost` `{ skuId, loserUserId, winnerUserId, tokenId, at }` on the event bus. Add the names to `CLAIMS_EVENTS` and the payload types to `claims-event.payloads.ts`.
- Write one structured log line for each, with a `metric` field.
- The `ClaimToken` table is the audit record. Never log or return the raw token except in the validate response.

### 7. Rollout flag

Add `CLAIM_TOKEN_REQUIRED` (env or `PlatformConfig`, whichever the repo uses for flags), off by default.
- **Off:** the token is optional. If it is sent, check it fully. If it is missing, use the old behaviour and log `metric: claims.token.missing`.
- **On:** the token is required.
- The race outcome (`CLAIMED_BY_OTHER_JUST_NOW`) applies either way.

### 8. Tests

Add a jest setup to `packages/claims`, copied from `packages/skus`, and a `test` script. Cover:
- a. valid token → one `SkuClaim`, token `CONSUMED` with `claimId` set
- b. same request again → 409 `REUSED`, still exactly one `SkuClaim`, `replayCount` is 1
- c. expired token → `EXPIRED`, item still unclaimed
- d. token used by another user → 400 `INVALID`
- e. token used with another item's tag → 400 `INVALID`
- f. **race:** two users validate, then both confirm with `Promise.all` → exactly one `CLAIMED`, one `CLAIMED_BY_OTHER_JUST_NOW`, one `SkuClaim`, loser token `LOST_TIEBREAK` (repeat 20 times)
- g. re-validating supersedes the old token
- h. claim → `revokeClaim()` → replay the original confirm → rejected, item stays unclaimed
- i. claim-code collision retry still works with the same token
- j. flag off with no token → old behaviour plus the log line

Use a real Postgres for the race test if the repo has a test database setup. Otherwise mock the transaction and say clearly that the race test needs a real database.

### 9. Docs

Update `docs/nfc-claim-verify-api.md` (new validate fields, confirm body, new outcome, error codes, flag, curl examples) and the CHANGELOG.

## Rules

- Follow the existing structure: service / repository / controller, Zod DTOs, `AppError`, `///` comments that explain why, 4-space indent.
- Only the repository touches Prisma.
- Don't change `revokeClaim()`, the ledger hash format, or `verify` / `ledger`.
- Don't remove or replace the existing rate limiting.
- The migration must not delete or change anything existing.

## When finished, report

1. Files changed or added.
2. The migration SQL.
3. Test results, and which tests need a real database.
4. Anything you did differently from this prompt and why.
5. What the mobile app must change: send `claimToken` from validate to confirm, handle `CLAIMED_BY_OTHER_JUST_NOW`, and on 409 or 410 call validate again.
