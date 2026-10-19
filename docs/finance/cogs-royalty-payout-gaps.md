# COGS / Artist royalty rate / Quarterly payout — spec vs code

Branch `feature/cogs-royalty-quarterly-payout`. Specs: `HitBox_Payments_Finance_and_Tax.md`
("2026-09-15 changes"), `DB_Alignment_Change_Log_2026-10-06.md`,
`HitBox_RBAC_Framework_Spec.md` (Flow 5, FR-10). All routes below are under
`/api/v1/admin/finance`.

## 1. Gap list (what the spec wanted vs what already existed)

| # | Spec asks | State before | What this branch does |
|---|-----------|--------------|-----------------------|
| COGS-1 | `DropPrice` versioned table: COGS (USD + INR), `salesPriceUsd/Inr`, generated gross profit, effective dates, status, costSource, varianceReason, approvedBy/At | A model **named `DropPrice` already exists** (products): one row per drop × market, `amount` + `costOfGoods`, `effectiveFrom/To`. No combined entry, no generated profit, no costSource/varianceReason, no version number | New table **`DropPricing`** (name differs because `DropPrice` is taken). One row = one version. Gross profit = Postgres `GENERATED ALWAYS … STORED`. |
| COGS-2 | COGS and both prices entered together, immutable | Prices editable per market through the products API | One write path (`POST …/pricing`); no PATCH. A change = new version with `varianceReason`. |
| COGS-3 | Only the active version affects new orders | Orders read `DropPrice` rows | Each new version is **projected onto the base `DropPrice` rows of the USD and INR markets** (previous rows closed, new opened). Order/ledger code is untouched; ledger snapshots are never rewritten. |
| COGS-4 | Entered at drop creation | Drop creation lives in products | **Not atomic with drop creation.** The console calls `POST /drops/:id/pricing` right after creating the drop. Not wired into the products module (merge safety). |
| ROY-1 | Artist-level rate in `RoyaltyRule.percentage`, set at artist creation by a privileged user | `RoyaltyRule` supports artist scope but there is no artist-specific create path, and generic create accepts any basis/scope | `POST /artists/:artistId/royalty-rate`: artist-only (collection/product/org null), basis `NET_PROFIT`, `payoutFrequency QUARTERLY`. Resolver and generic `POST /royalty-rules` untouched. |
| ROY-2 | Rate set "at artist creation" | Artists are created from a staff invitation event (`access-control.staff.invited`); there is no artist-create endpoint | **Not hooked into the invitation.** The artist exists from invite time, so the console sets the rate immediately after. Gap: nothing forces a rate to exist; an artist without one accrues no royalty (`FINANCE_NO_RULE`). |
| ROY-3 | Immutable for MVP; a change is a new effective-dated row | n/a | A second rate is refused (`409 FINANCE_RATE_OVERLAP`) while one is in force. To change: `POST /royalty-rules/:id/close`, then set again. |
| PAY-1 | Quarterly sweep Jan/Apr/Jul/Oct 1 | Only a manual threshold-based `POST /payouts/schedule` | `QuarterlyPayoutService` + opt-in scheduler + `POST /payouts/quarterly-sweep`. One payout per payee per currency; no threshold (every artist/quarter is decided). Entries carried over from earlier quarters/rejections are included. |
| PAY-2 | Pending-approval state | `PayoutStatus.SCHEDULED` | `SCHEDULED` **is** pending approval. Response adds `approvalState` (`PENDING_APPROVAL`/…). No enum change. |
| PAY-3 | Approve **and reject** with mandatory reason, own permission | `approve` existed, gated by `manage`, reason optional (`note`), no reject, no `approvalReason` stored | `approve`/`reject` need `payment-royalty:approve`; reason ≥5 chars required (`reason` or spec alias `approvalReason`); stored in `approvalReason` / `rejectionReason`. |
| PAY-4 | `REJECTED` state | Enum has no value | Rejected = status `CANCELLED` **plus** `rejectedById/At/rejectionReason` (new nullable columns); `approvalState: REJECTED`. No enum value added (user asked to confirm before adding one — not needed). |
| PAY-5 | Rejection does **not** auto-requeue (spec FR-10) | n/a | **Deliberate deviation per product decision:** rejected batch's entries return to `ACCRUED` and join the next sweep. |
| PAY-6 | Approve ≠ transfer, separate permission, recorded separately | `execute` needed only `manage`; `transferInitiatedById/At` unused | `transfer` needs `payment-royalty:transfer`; stamps `transferInitiatedById/At`. `/execute` is now an alias of `/transfer` (old `manage`-only path closed). |
| PAY-7 | Decisions audited, CRITICAL | `royalty.payout.execute` covered approve/pay/fail | New audit types `royalty.payout.approve/reject/transfer`, `drop.pricing.create`; sweep reuses `royalty.payout.schedule`, rate reuses `royalty.rule.change`. |
| RBAC-1 | Keys `drop:configure:global`, `payment-royalty:update|approve|transfer:global` | None existed in the catalog | Added to the catalog; granted to **HITBOX_SYSTEM_ADMIN only** (= "Hitbox Admin"). Seeded on the dev branch (`db:seed:authz`: 4 created). |

## 2. Open issues / needs a decision

1. ~~Currency of the single COGS~~ **Resolved (product decision):** `DropPricing` has two cost columns, `costOfGoods` (USD) and `costOfGoodsInr`, entered together. `grossProfitUsd = salesPriceUsd − costOfGoods`, `grossProfitInr = salesPriceInr − costOfGoodsInr`; the USD cost is projected onto the USD market row and the INR cost onto the INR row.
2. **UK/GBP market** (and variant-specific prices) are not projected: only USD and INR markets are
   written. A GBP `DropPrice` row keeps its old COGS.
3. **Spec name collision** — `DropPricing` vs spec `DropPrice` (see COGS-1). Rename is cheap now.
4. **Scheduler is in-process and opt-in** (`QUARTERLY_PAYOUT_SWEEP_ENABLED=true`, hourly tick,
   idempotent). Production likely wants an external cron hitting `POST /payouts/quarterly-sweep`
   instead; both are safe together.
5. The older threshold sweep (`POST /payouts/schedule`) still exists and still uses
   `payoutThreshold`; it creates `SCHEDULED` batches with no period set.
6. Pre-existing, not touched: `prisma migrate diff` against the copied `local` data shows
   `RefundRequest.gateway*` columns that exist in the DB but not in this branch's schema.

## 3. API reference

Money is a string. Errors use the app's `{ error: { code, message, details } }` shape.

### Drop pricing — `drop:configure:global`
- `POST /drops/:dropId/pricing` → 201
  `{ costOfGoods (USD), costOfGoodsInr, salesPriceUsd, salesPriceInr, costSource?, varianceReason?, effectiveFrom? }`
  (strict; `varianceReason` ≥5 chars required when superseding; `effectiveFrom` not in the future)
  → `{ data: DropPricingView }`
- `GET /drops/:dropId/pricing` → `{ data: DropPricingView[] }` (newest version first)
- `GET /drops/:dropId/pricing/active` → `{ data: DropPricingView }` (404 if none)

`DropPricingView`: `id, publicCode, dropId, version, costOfGoods, costOfGoodsInr, salesPriceUsd, salesPriceInr,
grossProfitUsd, grossProfitInr, status (ACTIVE|DISABLED), isActive, effectiveFrom, effectiveTo,
costSource, varianceReason, approvedById, approvedAt, createdAt`.

### Artist royalty rate
- `POST /artists/:artistId/royalty-rate` — `payment-royalty:update:global` → 201
  `{ percentage: "12.5", effectiveFrom?, payoutThreshold? }` (strict; `percentage` in (0,100];
  `basis`/scope rejected) → `{ data: ArtistRoyaltyRateView }`
- `GET /artists/:artistId/royalty-rate` — `payment-royalty:read` → `{ data: ArtistRoyaltyRateView | null }`

`ArtistRoyaltyRateView`: `ruleId, artistId, basis, percentage, effectiveFrom, effectiveTo, isInForce`.

### Payouts
- `GET /payouts?status=SCHEDULED&page=&limit=` — `payment-royalty:read` (pending approval queue)
- `GET /payouts/:payoutId`
- `POST /payouts/:payoutId/approve` — `payment-royalty:approve:global`; `{ reason }` (alias `approvalReason`)
- `POST /payouts/:payoutId/reject` — `payment-royalty:approve:global`; `{ reason }`
- `POST /payouts/:payoutId/transfer` (alias `/execute`) — `payment-royalty:transfer:global`;
  `{ gatewayPayoutRef, paidAt? }` (only from APPROVED)
- `POST /payouts/quarterly-sweep` — `payment-royalty:manage:global`; `{ asOf?, dryRun? }`
  → `{ data: { quarter, periodStart, periodEnd, dryRun, created[], skipped[] } }`

`PayoutView` (existing fields plus): `approvalState`, `approvalReason`, `rejectedById`,
`rejectedAt`, `rejectionReason`, `transferInitiatedById`, `transferInitiatedAt`,
`payoutPeriodStart`, `payoutPeriodEnd`.

Error codes: `FINANCE_REASON_REQUIRED` (400), `FINANCE_INVALID_TRANSITION` (409, wrong state),
`FINANCE_RATE_OVERLAP` (409), `FINANCE_DROP_NOT_FOUND` / `FINANCE_ARTIST_NOT_FOUND` (404),
`FINANCE_FORBIDDEN` / permission-guard 403.

### State machine
`SCHEDULED (pending approval)` → approve → `APPROVED` → transfer → `PAID`
`SCHEDULED` → reject → `CANCELLED` + rejection trail (entries back to `ACCRUED`)

## 4. Merge-safety footprint
New: migration `20261019100000_drop_pricing_and_payout_rejection` (one table + 3 nullable columns),
`packages/finance/prisma/drop-pricing.prisma`, new finance service/controller/dto/repository/test
files. One-line additions in shared files: `public-code.ts` prefix, permission/role catalogs
(+role-catalog test list), audit event catalog (4 entries), `finance.prisma` (3 columns),
finance `module.ts`/`index.ts`/constants/access, `bootstrap.ts` + `server.ts` (opt-in scheduler).

## 5. MVP scope rules and public codes (added after UI review)

- **Currency: USD and INR only.** Admin finance lists (royalty-entries, payouts, balances, ledger,
  adjustments, revenue-summary) and the payments transaction list default to `currency IN (USD, INR)`;
  list/create DTOs reject `GBP` (400). The enum is untouched. Both payout sweeps skip GBP.
- **Payees: artists only.** royalty-entries, payouts and balances default to `payeeType = ARTIST`
  (the `organizationId` filter on royalty-entries is ignored). The quarterly sweep skips ORGANIZATION
  payees with reason `Organization payouts are not in MVP scope`. No org rows are modified.
- **Rules:** `POST /royalty-rules` rejects `basis != NET_PROFIT` (`FINANCE_BASIS_NOT_SUPPORTED`) and any
  scope other than `artistId` alone (`FINANCE_RULE_SCOPE_NOT_SUPPORTED`). Resolver and legacy rows untouched.
- **Public codes** (null when a row has none; ids kept): entries `publicCode, orderPublicCode,
  payoutPublicCode, adjustsEntryPublicCode, payee.publicCode`; payouts `publicCode, payee.publicCode`;
  rules `publicCode, scope.{artist,product,collection,organization}PublicCode`; balances
  `payeePublicCode`; platform ledger `publicCode, orderPublicCode`; adjustments
  `publicCode, orderPublicCode, targetPublicCode`; drop pricing `dropPublicCode`; artist rate
  `artistPublicCode`.
