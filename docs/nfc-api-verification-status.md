# NFC Claim API — Verification Status

**Status: ✅ verified end-to-end.** Every endpoint was exercised against a real
PostgreSQL and all assertions passed. The production Neon DB was never touched.

- Full run report: [nfc-api-e2e-test-report.md](nfc-api-e2e-test-report.md)
- Result: **54/54 assertions passed across 16 API calls, 0 failures**

---

## What was verified

| Check | How | Result |
|-------|-----|--------|
| All 11 packages typecheck | `pnpm -r typecheck` | ✅ 0 errors |
| Merged Prisma schema valid | `pnpm db:validate` | ✅ valid |
| **Migration applies cleanly** | `prisma migrate deploy` on a fresh DB | ✅ applied |
| Seed runs against new schema | `tsx prisma/seed.ts` | ✅ |
| **Every endpoint, end-to-end** | E2E harness over HTTP against real Postgres | ✅ 54/54 |

### The tap flow, proven

The harness simulates two people tapping the same tag:

1. **jameela taps an unclaimed tag** → `outcome: CLAIMED`, she becomes the owner, a `claimCode` is issued, ledger gets MINT (seq 0) + CLAIM (seq 1).
2. **akash re-taps the same tag** → `outcome: ALREADY_CLAIMED`, `claimedByYou: false`, message *"… already claimed by jameela."* — exactly the demo behavior requested.
3. **jameela re-taps her own** → `ALREADY_CLAIMED`, `claimedByYou: true`, *"You already own …"*.
4. `verify` shows owner = jameela, `ledgerLength: 2`; the **hash chain links verify** (`seq1.previousHash == seq0.hash`, both sha256); history shows one open ownership period.

Error paths proven: unknown tag → `404`, no auth → `401`, bad product body → `422`.

### Not exercised

- **Clerk JWT verification** — the harness stubs `requireAuth` to simulate two
  users, so Clerk's own token check isn't run (needs a live session token). The
  `401` path (missing auth) *is* covered.
- **Peer-to-peer transfer** — intentionally removed for the demo.

---

## Environment note

Tests ran against a **throwaway embedded PostgreSQL** (Docker Desktop wasn't
running at test time). The runner lives in the session scratchpad
(`pgtest/run-embedded-e2e.cjs`) and pulls a local Postgres binary via npm — it
touches nothing in the repo and never connects to Neon.

## How to re-run

With Docker running:

```bash
bash "<scratchpad>/run-e2e.sh"
```

Or against any disposable Postgres you control:

```bash
export DATABASE_URL="postgresql://.../hitbox_test"
export DIRECT_URL="$DATABASE_URL"
pnpm --filter @hitbox/database exec prisma migrate deploy --schema prisma/schema.prisma
REPORT_PATH="$PWD/docs/nfc-api-e2e-test-report.md" pnpm --filter backend exec tsx scripts/e2e.ts
```

The harness exits non-zero if any assertion fails and regenerates
`docs/nfc-api-e2e-test-report.md`.
