# Auth & Registration — validation & test coverage

How each QA case is enforced in the backend, and where it is tested. Registration, login, password policy, and the email-verification **code** all live in **Clerk** — the backend never creates accounts or handles passwords. The backend's job is to validate the data it receives (Zod), project Clerk users into the local `users` table (webhook + events), and gate every protected route (`requireAuth`).

## Where the rules live

| Concern | Enforced by | Code |
|---|---|---|
| Registration input shape (email format, username, names) | Zod | [registration.dto.ts](../packages/auth/src/dto/registration.dto.ts) |
| Email uniqueness | `RegistrationService` + `IAccountLookup.emailExists` | [registration.service.ts](../packages/auth/src/service/registration.service.ts) |
| Session verification, account state, email-verified | `requireAuth` | [require-auth.middleware.ts](../packages/auth/src/middleware/require-auth.middleware.ts) |
| Webhook signature + idempotency + translation | `AuthWebhookService` | [auth-webhook.service.ts](../packages/auth/src/service/auth-webhook.service.ts) |
| `email_verified` sync from Clerk | webhook DTO + users projection | [clerk-webhook.dto.ts](../packages/auth/src/dto/clerk-webhook.dto.ts), [user.repository.ts](../packages/users/src/repository/user.repository.ts) |

## Matrix coverage

| # | Case | Outcome | Enforced / tested |
|---|---|---|---|
| 1 | Register new buyer (valid email) | `users` row created via Clerk `user.created` webhook with `clerkUserId`, `state=ACTIVE`, `emailVerified` synced | Clerk + webhook → `syncFromClerk`; webhook test |
| 2 | Email verification enforced before access | Protected APIs return **403 `AUTH_EMAIL_UNVERIFIED`** when the synced primary email is not verified (Clerk also won't mint a session pre-verification) | `requireAuth` test |
| 3 | Register with already-registered email | **409 `AUTH_EMAIL_TAKEN`**; email is unique in `users` | `RegistrationService` test |
| 4 | Invalid email format rejected | **422 `VALIDATION_ERROR`** with field-level `details` | Zod schema test |
| 5 | Weak password rejected | Clerk password policy (backend never sees passwords) | Clerk — n/a to backend |
| 6 | Login with valid credentials | Clerk issues session JWT; `requireAuth` verifies it and attaches `req.auth` | `requireAuth` happy-path test |
| 7 | Login with wrong password | Clerk rejects; no session | Clerk — n/a |
| 8 | Suspended user cannot use the app | **403 `AUTH_ACCOUNT_SUSPENDED`** on protected routes | `requireAuth` test |
| 9 | Soft-deleted user cannot login | **401 `AUTH_ACCOUNT_NOT_FOUND`** (deletedAt set → `DELETED`) | `requireAuth` test |
| 10 | Expired session forces re-auth | **401 `AUTH_INVALID_TOKEN`** (Clerk `verifyToken` throws) | `requireAuth` test |
| 11 | Logout clears session | Client-side (Clerk); backend is stateless per request | n/a to backend |
| 12 | Webhook idempotency (duplicate delivery) | Duplicate `svix-id` ignored: one `auth_webhook_events` row, one publish | webhook test |

## Running the tests

```bash
pnpm --filter @hitbox/auth test
```

Runner is **Jest** (via `ts-jest`, compiling to CommonJS so `jest.mock` hoisting works) — config in `packages/auth/jest.config.cjs` + `tsconfig.jest.json`. 23 unit tests across three suites (mocked Clerk/svix — no DB or network):

- `tests/registration.test.ts` — Zod schema + `RegistrationService` (cases 3, 4).
- `tests/auth-webhook.test.ts` — signature, idempotency, verified/unverified translation (cases 1, 12).
- `tests/require-auth.test.ts` — no token / invalid / deleted / suspended / unverified / happy path (cases 2, 6, 8, 9, 10).

## The `email_verified` field

Mirrored onto `users.email_verified` from Clerk on every sync (webhook `user.created`/`updated` and, if enabled, JIT provisioning), derived from the primary email's Clerk `verification.status === 'verified'`. Column default is `true` so accounts created before the column stay usable; the sync path writes the real value going forward. `requireAuth` refuses protected routes when it is `false` — defense-in-depth on top of Clerk's own pre-verification session gate.
