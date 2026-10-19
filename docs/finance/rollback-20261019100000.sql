-- ROLLBACK for migration 20261019100000_drop_pricing_and_payout_rejection
-- Deliberately NOT in prisma/migrations: it never runs automatically.
-- Run it by hand, in one transaction, against the intended database only:
--     psql "$DIRECT_URL" -1 -f docs/finance/rollback-20261019100000.sql
-- (`-1` wraps the file in a single transaction; this file also has its own
--  BEGIN/COMMIT, so run it under psql without -1, or remove them to test.)
--
-- WHAT THIS REVERSES (everything the migration added, nothing else):
--   * table "DropPricing" with its primary key, the unique indexes
--     ("publicCode", ("dropId","version")), the ("dropId","effectiveFrom") index
--     and the generated columns "grossProfitUsd" / "grossProfitInr".
--   * "RoyaltyPayout"."rejectedById", "rejectedAt", "rejectionReason".
--   The migration added no enum value, no foreign key and no other object.
--
-- DATA LOST (irreversible once committed):
--   * Every DropPricing row: all COGS (USD and INR) and USD/INR sales-price
--     versions, their varianceReason / costSource / approver trail.
--     NOT lost: the per-market "DropPrice" rows the pricing service projected
--     (same figures live on in them) - they are not touched here.
--   * Every payout rejection trail: who rejected, when, and the reason. Rejected
--     payouts keep status CANCELLED, so after rollback they are
--     indistinguishable from other cancelled batches.
--
-- AUDIT ROWS (table "AuditEvent", FK "AuditEvent_eventType_fkey" ->
-- "AuditEventType"): this migration inserted no AuditEventType rows - they come
-- from `db:seed:audit`, not from SQL. Four event types were introduced by the
-- same change set, and AuditEvent is append-only history, so the decision is:
--     royalty.payout.approve    KEEP the AuditEvent rows and the type row
--     royalty.payout.reject     KEEP the AuditEvent rows and the type row
--     royalty.payout.transfer   KEEP the AuditEvent rows and the type row
--     drop.pricing.create       KEEP the AuditEvent rows and the type row
-- Deleting either would destroy the record of real approvals and transfers; the
-- type rows are harmless if the code that emits them is rolled back too. Only
-- if you must remove them, delete the AuditEvent rows FIRST, then the types
-- (statements at the bottom, commented out; do not run them on a shared DB).
--
-- THE _prisma_migrations ROW TO DELETE (done below): migration_name =
--     '20261019100000_drop_pricing_and_payout_rejection'
-- Without this, `prisma migrate deploy` believes the migration is applied and
-- will not re-create the objects.

BEGIN;

-- 1. DropPricing (dropping the table drops its indexes, PK and generated columns).
DROP TABLE IF EXISTS "DropPricing";

-- 2. RoyaltyPayout rejection trail.
ALTER TABLE "RoyaltyPayout"
    DROP COLUMN IF EXISTS "rejectionReason",
    DROP COLUMN IF EXISTS "rejectedAt",
    DROP COLUMN IF EXISTS "rejectedById";

-- 3. Forget the migration so deploy can re-apply it.
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20261019100000_drop_pricing_and_payout_rejection';

COMMIT;

-- ── OPTIONAL, NOT RUN: removing the audit trail of the new event types ───────
-- DELETE FROM "AuditEvent" WHERE "eventType" IN
--     ('royalty.payout.approve','royalty.payout.reject','royalty.payout.transfer','drop.pricing.create');
-- DELETE FROM "AuditEventType" WHERE "eventType" IN
--     ('royalty.payout.approve','royalty.payout.reject','royalty.payout.transfer','drop.pricing.create');
