-- ============================================================================
-- BUYER ADDRESS BOOK + TAX-INCLUSIVE INVOICES
--
-- 1. Address: `usage` (SHIPPING | BILLING | BOTH) and a single `isDefault`
--    replace the two default flags. Existing rows become BOTH; the legacy
--    default (shipping first, then billing, then newest) becomes the one
--    default per user.
-- 2. At most one active default per user, enforced by a partial unique index
--    (Prisma cannot express it, same as NfcTagKey_one_active_per_tag).
-- 3. Invoice.pricesIncludeTax: invoices issued before this migration added tax
--    on top of the order price (false); new ones treat the price as inclusive.
-- ============================================================================

-- CreateEnum
CREATE TYPE "AddressBookUsage" AS ENUM ('SHIPPING', 'BILLING', 'BOTH');

-- AlterTable: Address (add with a default to backfill, then drop the default
-- so the table matches the schema, which declares none)
ALTER TABLE "Address" ADD COLUMN "usage" "AddressBookUsage" NOT NULL DEFAULT 'BOTH',
ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Address" a
SET "isDefault" = true
FROM (
    SELECT DISTINCT ON ("userId") "id"
    FROM "Address"
    WHERE "isActive" AND "archivedAt" IS NULL AND ("isDefaultShipping" OR "isDefaultBilling")
    ORDER BY "userId", "isDefaultShipping" DESC, "isDefaultBilling" DESC, "createdAt" DESC
) d
WHERE a."id" = d."id";

ALTER TABLE "Address" ALTER COLUMN "usage" DROP DEFAULT,
ALTER COLUMN "isDefault" DROP DEFAULT,
DROP COLUMN "isDefaultShipping",
DROP COLUMN "isDefaultBilling";

-- CreateIndex
CREATE INDEX "Address_userId_isActive_idx" ON "Address"("userId", "isActive");

-- Exactly one active default per user (Prisma cannot express a partial index).
CREATE UNIQUE INDEX "Address_one_default_per_user" ON "Address"("userId")
WHERE "isDefault" AND "isActive" AND "archivedAt" IS NULL;

-- AlterTable: Invoice
ALTER TABLE "Invoice" ADD COLUMN "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ALTER COLUMN "pricesIncludeTax" DROP DEFAULT;
