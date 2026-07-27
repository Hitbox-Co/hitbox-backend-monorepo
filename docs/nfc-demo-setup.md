# NFC tap-to-claim — demo setup

Everything wired for the physical-tag demo with tag **`534A70C1610001`**.

## The URL to store on the NTAG216 chip

```
hitboxstatic://claim/534A70C1610001
```

Write it as an **NDEF URI record** (NFC Tools → Write → Add a record → URL/URI).
Optionally add an **Android Application Record** (`com.subratadasdev1.hitboxstatic`)
so a tap reliably opens the app. Tapping opens the app → claim page for that tag.

> The app also reads the chip UID directly when open, so a blank tag works too —
> but the URL is what makes a tap **launch** the app.

## What's already done

- **Backend claim/verify/ledger** — built, and verified end-to-end against Neon
  with the real tag (claim → `CLAIMED`, re-tap → `ALREADY_CLAIMED by <name>`).
- **Auth = real Clerk.** `DEMO_AUTH_ENABLED=false` — the backend only accepts a
  valid Clerk session token, and the app must be **signed in** to claim (verified:
  a request without a token returns `401 AUTH_UNAUTHENTICATED`). The app wraps
  everything in `ClerkProvider` (SecureStore token cache) and sends the session
  token as a Bearer header; the claim screen blocks and shows "Sign in required"
  when signed out.
  - Sign-**in** (email/password) is wired in `EmailLogin` via Clerk `useSignIn`.
  - Requires **email/password enabled** in the Clerk dashboard and a **user account**
    to exist (sign-up screens are still UI-only — create a user in the Clerk
    dashboard, or wire sign-up next).
- **Tag provisioned** — product `534470000001` carries `tagId 534A70C1610001`,
  currently **UNCLAIMED** (fresh), with its "First Time" HitBox origin ledger row.
- **DB schema** — synced to Neon via `prisma db push` (this DB is db-push managed,
  not migrate; see note below).
- **`.env` fix** — `NODE_ENV` was `developments` (typo) → would exit on boot;
  corrected to `development`.

## Running the demo

1. **Backend** (already running on `:8000` in this session; to restart):
   ```bash
   cd hitbox-backend-monorepo && pnpm dev
   ```
2. **Tunnel** so your phone can reach it (its URL is in the app's `EXPO_PUBLIC_API_URL`):
   ```bash
   ngrok http --url=ultra-coveting-payroll.ngrok-free.dev 8000
   ```
3. **App** — build/install the dev client on a physical Android device, then:
   ```bash
   cd hitbox-static && npx expo start --dev-client   # add --tunnel if phone isn't on your LAN
   ```
   (Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk` → `adb install` it.)
4. Open the app → tap the chip (or home → "Scan NFC & Claim" → tap).

## Reset between demos

Each tap claims the tag. To make it claimable again:

```bash
pnpm --filter @hitbox/database exec dotenv -e ../../../.env -- tsx prisma/reset-demo-tag.ts
```

Provision a fresh tag: `prisma/provision-demo-tag.ts` (edit the TAG_ID inside).

## Notes / caveats

- **Migration history**: this Neon DB was created with `db push`, so it has no
  Prisma migration history. I baselined the two prior migrations and kept using
  `db push` for the ledger changes. Keep using `pnpm db:push`-style sync for this
  DB, or adopt migrations deliberately later.
- **Transaction timeout**: the claim `$transaction` runs several writes; against
  remote Neon the default 5s was too tight (caused a flaky failure), so it's
  raised to 20s in `claims.repository.ts`.
- **Auth is demo-only**: `X-Demo-User` must be disabled (`DEMO_AUTH_ENABLED`
  unset) before any real deployment; wire Clerk instead.
