-- ============================================================================
-- Finance & Revenue Ledger  (HitBox_Finance_Revenue_Ledger_Database_Schema v2.0)
--
-- Adds the four things the design document needs and the schema did not have:
--   * royalty entries that carry their own arithmetic and a payout status
--   * RoyaltyPayout      — the batch that settles them
--   * AdjustmentEntry    — the immutability principle, as a table
--   * DisputeCase        — chargebacks, which are not refunds
-- plus the refund columns the physical-return workflow needs (tag condition,
-- resale quarantine, claim revocation) and the read indexes for all of it.
--
-- Columns added NOT NULL to tables that already exist are added WITH a
-- default and then stripped of it, so the migration is safe against a
-- non-empty table and the default does not silently become the app's
-- behaviour afterwards. See docs/finance/schema-changes.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "RoyaltyEntryStatus" AS ENUM ('ACCRUED', 'PENDING_PAYOUT', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "RoyaltyPayeeType" AS ENUM ('ARTIST', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "PayoutFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('SCHEDULED', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentTargetType" AS ENUM ('ROYALTY_LEDGER_ENTRY', 'FINANCE_LEDGER_ENTRY', 'ORDER', 'PAYMENT_TRANSACTION', 'ROYALTY_PAYOUT');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('REFUND_REVERSAL', 'DISPUTE_LOSS', 'CHARGEBACK_FEE', 'CALCULATION_ERROR', 'RULE_CORRECTION', 'GOODWILL', 'MANUAL_CORRECTION');

-- CreateEnum
CREATE TYPE "FinanceCategory" AS ENUM ('SALE_REVENUE', 'COST_OF_GOODS', 'GATEWAY_FEE', 'REFUND', 'CHARGEBACK', 'ROYALTY_EXPENSE', 'ROYALTY_PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('DEFECTIVE_ITEM', 'DEFECTIVE_TAG', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'DUPLICATE_CHARGE', 'BUYER_CHANGED_MIND', 'FRAUDULENT_CHARGE', 'OTHER');

-- CreateEnum
CREATE TYPE "NfcTagCondition" AS ENUM ('INTACT', 'DAMAGED', 'MISSING', 'TAMPERED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'ACCEPTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('FRAUDULENT', 'PRODUCT_NOT_RECEIVED', 'PRODUCT_UNACCEPTABLE', 'DUPLICATE', 'SUBSCRIPTION_CANCELED', 'CREDIT_NOT_PROCESSED', 'UNRECOGNIZED', 'OTHER');

-- AlterTable
ALTER TABLE "RoyaltyRule" ADD COLUMN     "payoutFrequency" "PayoutFrequency",
ADD COLUMN     "payoutThreshold" DECIMAL(12,2);

-- AlterTable
-- accrualKey backfills from the row's own id: every pre-existing entry is
-- distinct and none of them came from a repeatable trigger, so id::text is a
-- correct idempotency key for them.
ALTER TABLE "RoyaltyLedgerEntry" ADD COLUMN     "accrualKey" TEXT,
ADD COLUMN     "accruedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "basis" "RoyaltyBasis" NOT NULL DEFAULT 'NET_PROFIT',
ADD COLUMN     "claimId" UUID,
ADD COLUMN     "costOfGoods" DECIMAL(12,2),
ADD COLUMN     "grossRevenue" DECIMAL(12,2),
ADD COLUMN     "netProfit" DECIMAL(12,2),
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payeeArtistId" UUID,
ADD COLUMN     "payeeOrganizationId" UUID,
ADD COLUMN     "payeeType" "RoyaltyPayeeType" NOT NULL DEFAULT 'ARTIST',
ADD COLUMN     "payoutId" UUID,
ADD COLUMN     "percentage" DECIMAL(6,3),
ADD COLUMN     "skuId" UUID,
ADD COLUMN     "status" "RoyaltyEntryStatus" NOT NULL DEFAULT 'ACCRUED';

UPDATE "RoyaltyLedgerEntry" SET "accrualKey" = "id"::text WHERE "accrualKey" IS NULL;
UPDATE "RoyaltyLedgerEntry" SET "accruedAt" = "createdAt";
ALTER TABLE "RoyaltyLedgerEntry" ALTER COLUMN "accrualKey" SET NOT NULL;
ALTER TABLE "RoyaltyLedgerEntry" ALTER COLUMN "accruedAt" DROP DEFAULT,
  ALTER COLUMN "basis" DROP DEFAULT,
  ALTER COLUMN "payeeType" DROP DEFAULT,
  ALTER COLUMN "status" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FinanceLedgerEntry" ADD COLUMN     "adjustsEntryId" UUID,
ADD COLUMN     "category" "FinanceCategory" NOT NULL DEFAULT 'SALE_REVENUE',
ADD COLUMN     "postingKey" TEXT;

ALTER TABLE "FinanceLedgerEntry" ALTER COLUMN "category" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "claimId" UUID,
ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RefundRequest" ADD COLUMN     "claimRevokedAt" TIMESTAMP(3),
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD',
ADD COLUMN     "nfcTagCondition" "NfcTagCondition",
ADD COLUMN     "physicalReturnRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "reasonCode" "RefundReason" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "resaleBlockedUntil" TIMESTAMP(3);

-- A pre-existing refund inherits its order's currency rather than the USD
-- placeholder the column was created with.
UPDATE "RefundRequest" r SET "currency" = o."currency" FROM "Order" o WHERE o."id" = r."orderId";
ALTER TABLE "RefundRequest" ALTER COLUMN "currency" DROP DEFAULT,
  ALTER COLUMN "physicalReturnRequired" DROP DEFAULT,
  ALTER COLUMN "reasonCode" DROP DEFAULT;

-- CreateTable
CREATE TABLE "RoyaltyPayout" (
    "id" UUID NOT NULL,
    "payeeType" "RoyaltyPayeeType" NOT NULL,
    "payeeArtistId" UUID,
    "payeeOrganizationId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "thresholdApplied" DECIMAL(12,2),
    "status" "PayoutStatus" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "gatewayPayoutRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoyaltyPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdjustmentEntry" (
    "id" UUID NOT NULL,
    "targetType" "AdjustmentTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "orderId" UUID,
    "amountAdjustment" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "reasonCode" "AdjustmentReason" NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" UUID,
    "refundRequestId" UUID,
    "disputeCaseId" UUID,
    "resultingEntryId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdjustmentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeCase" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentTransactionId" UUID,
    "gateway" "PaymentGateway" NOT NULL,
    "gatewayCaseRef" TEXT,
    "reasonCode" "DisputeReason" NOT NULL,
    "reason" TEXT,
    "status" "DisputeStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "feeAmount" DECIMAL(12,2),
    "evidenceDueBy" TIMESTAMP(3),
    "evidenceSubmittedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisputeCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoyaltyPayout_payeeArtistId_status_idx" ON "RoyaltyPayout"("payeeArtistId", "status");

-- CreateIndex
CREATE INDEX "RoyaltyPayout_payeeOrganizationId_status_idx" ON "RoyaltyPayout"("payeeOrganizationId", "status");

-- CreateIndex
CREATE INDEX "RoyaltyPayout_status_scheduledAt_idx" ON "RoyaltyPayout"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "AdjustmentEntry_targetType_targetId_idx" ON "AdjustmentEntry"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdjustmentEntry_orderId_idx" ON "AdjustmentEntry"("orderId");

-- CreateIndex
CREATE INDEX "AdjustmentEntry_createdAt_idx" ON "AdjustmentEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeCase_gatewayCaseRef_key" ON "DisputeCase"("gatewayCaseRef");

-- CreateIndex
CREATE INDEX "DisputeCase_orderId_idx" ON "DisputeCase"("orderId");

-- CreateIndex
CREATE INDEX "DisputeCase_status_evidenceDueBy_idx" ON "DisputeCase"("status", "evidenceDueBy");

-- CreateIndex
CREATE INDEX "RoyaltyRule_productId_effectiveFrom_idx" ON "RoyaltyRule"("productId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "RoyaltyRule_collectionId_effectiveFrom_idx" ON "RoyaltyRule"("collectionId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "RoyaltyRule_artistId_effectiveFrom_idx" ON "RoyaltyRule"("artistId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "RoyaltyRule_organizationId_effectiveFrom_idx" ON "RoyaltyRule"("organizationId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RoyaltyLedgerEntry_accrualKey_key" ON "RoyaltyLedgerEntry"("accrualKey");

-- CreateIndex
CREATE INDEX "RoyaltyLedgerEntry_payeeArtistId_status_currency_idx" ON "RoyaltyLedgerEntry"("payeeArtistId", "status", "currency");

-- CreateIndex
CREATE INDEX "RoyaltyLedgerEntry_payeeOrganizationId_status_currency_idx" ON "RoyaltyLedgerEntry"("payeeOrganizationId", "status", "currency");

-- CreateIndex
CREATE INDEX "RoyaltyLedgerEntry_orderId_idx" ON "RoyaltyLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "RoyaltyLedgerEntry_claimId_idx" ON "RoyaltyLedgerEntry"("claimId");

-- CreateIndex
CREATE INDEX "RoyaltyLedgerEntry_payoutId_idx" ON "RoyaltyLedgerEntry"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceLedgerEntry_postingKey_key" ON "FinanceLedgerEntry"("postingKey");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_orderId_idx" ON "FinanceLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_category_createdAt_idx" ON "FinanceLedgerEntry"("category", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_createdAt_idx" ON "FinanceLedgerEntry"("createdAt");

-- CreateIndex
CREATE INDEX "Order_organizationId_placedAt_idx" ON "Order"("organizationId", "placedAt");

-- CreateIndex
CREATE INDEX "Order_status_placedAt_idx" ON "Order"("status", "placedAt");

-- CreateIndex
CREATE INDEX "Order_skuId_idx" ON "Order"("skuId");

-- CreateIndex
CREATE INDEX "Order_claimId_idx" ON "Order"("claimId");

-- CreateIndex
CREATE INDEX "InventoryReservation_skuId_status_idx" ON "InventoryReservation"("skuId", "status");

-- CreateIndex
CREATE INDEX "InventoryReservation_status_expiresAt_idx" ON "InventoryReservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_orderId_idx" ON "PaymentTransaction"("orderId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_createdAt_idx" ON "PaymentTransaction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_gatewayRef_idx" ON "PaymentTransaction"("gatewayRef");

-- CreateIndex
CREATE INDEX "RefundRequest_orderId_idx" ON "RefundRequest"("orderId");

-- CreateIndex
CREATE INDEX "RefundRequest_status_createdAt_idx" ON "RefundRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "RoyaltyLedgerEntry" ADD CONSTRAINT "RoyaltyLedgerEntry_payeeArtistId_fkey" FOREIGN KEY ("payeeArtistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyLedgerEntry" ADD CONSTRAINT "RoyaltyLedgerEntry_payeeOrganizationId_fkey" FOREIGN KEY ("payeeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyLedgerEntry" ADD CONSTRAINT "RoyaltyLedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "RoyaltyPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayout" ADD CONSTRAINT "RoyaltyPayout_payeeArtistId_fkey" FOREIGN KEY ("payeeArtistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayout" ADD CONSTRAINT "RoyaltyPayout_payeeOrganizationId_fkey" FOREIGN KEY ("payeeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentEntry" ADD CONSTRAINT "AdjustmentEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeCase" ADD CONSTRAINT "DisputeCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeCase" ADD CONSTRAINT "DisputeCase_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

