-- HitBox v3.1 — additive schema changes.
--
-- Contains no destructive statement: no DROP TABLE, no DROP COLUMN, no ALTER
-- COLUMN ... TYPE, no enum value removed, no table or column renamed. The
-- Prisma-side renames in this release (Product → Drop, ProductClaim → SkuClaim,
-- ProductPrice.productId → dropId, Invoice.productCostId → dropPriceId, …) are
-- carried entirely by @@map/@map, which is why none of them appear below.
--
-- The single DROP INDEX is the DropPrice unique-key swap: the three-column key
-- is replaced by a four-column one that includes `effectiveFrom`, so a
-- drop/variant/market triple can hold its price history. "At most one *open*
-- price" is not expressible as a unique index and is now a query condition —
-- see docs/schema-v3.1-changes.md §4.

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'EXECUTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('RETRY_QUEUED', 'NEEDS_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupplyBatchStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'ACCEPTED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerTxType" ADD VALUE 'REVOKE';
ALTER TYPE "LedgerTxType" ADD VALUE 'REISSUE';

-- AlterEnum
ALTER TYPE "SupplyItemType" ADD VALUE 'COLLECTIBLE';

-- DropIndex
DROP INDEX "ProductPrice_productId_variantId_marketId_key";

-- AlterTable
ALTER TABLE "AdjustmentEntry" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "BlockchainLedger" ADD COLUMN     "actorRef" UUID,
ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "hashVersion" SMALLINT NOT NULL DEFAULT 1,
ADD COLUMN     "nfcTagId" UUID,
ADD COLUMN     "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "platformSignature" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "signingKeyVersion" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "publishAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProductPrice" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "effectiveTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RolePermission" ADD COLUMN     "requiresReason" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RoyaltyLedgerEntry" ADD COLUMN     "provenanceLedgerId" UUID;

-- AlterTable
ALTER TABLE "RoyaltyPayout" ADD COLUMN     "approvalReason" TEXT,
ADD COLUMN     "payoutPeriodEnd" DATE,
ADD COLUMN     "payoutPeriodStart" DATE,
ADD COLUMN     "transferInitiatedAt" TIMESTAMP(3),
ADD COLUMN     "transferInitiatedById" UUID;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "currentNfcTagId" UUID,
ADD COLUMN     "supplyBatchId" UUID;

-- AlterTable
ALTER TABLE "SupplyBatch" ADD COLUMN     "batchDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "dropId" UUID,
ADD COLUMN     "rowsAccepted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowsReceived" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowsRejected" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "SupplyBatchStatus" NOT NULL DEFAULT 'UPLOADED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "validationReportRef" TEXT,
ADD COLUMN     "vendorInvoiceRef" TEXT;

-- AlterTable
ALTER TABLE "SupportCase" ADD COLUMN     "nfcTagId" UUID;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "country" VARCHAR(2),
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "CogsReconciliation" (
    "id" UUID NOT NULL,
    "reconciliationNumber" VARCHAR(10) NOT NULL,
    "reconciliationMonth" DATE NOT NULL,
    "dropId" UUID NOT NULL,
    "recordedCost" DECIMAL(12,2) NOT NULL,
    "actualCost" DECIMAL(12,2) NOT NULL,
    "varianceAmount" DECIMAL(12,2),
    "variancePercentage" DECIMAL(5,2),
    "varianceReason" TEXT,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvalReason" TEXT,
    "newCost" DECIMAL(12,2),
    "effectiveFromDate" DATE,
    "supportingDocuments" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CogsReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionCase" (
    "id" UUID NOT NULL,
    "exceptionCode" VARCHAR(10) NOT NULL,
    "caseType" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" UUID NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'RETRY_QUEUED',
    "slaDeadline" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NfcTag" (
    "id" UUID NOT NULL,
    "nfcTagCode" VARCHAR(10) NOT NULL,
    "supplyBatchId" UUID NOT NULL,
    "skuId" UUID,
    "tagUidHash" CHAR(64) NOT NULL,
    "tagUidEncrypted" TEXT NOT NULL,
    "qcStatus" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "qcReportedAt" TIMESTAMP(3),
    "qcNotes" TEXT,
    "lifecycleState" "TagLifecycleState" NOT NULL DEFAULT 'UNPROVISIONED',
    "keyReference" TEXT,
    "lastTapCounter" INTEGER NOT NULL DEFAULT 0,
    "tamperStatus" TEXT,
    "personalizedAt" TIMESTAMP(3),
    "boundAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NfcTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NfcVerification" (
    "id" UUID NOT NULL,
    "verificationCode" VARCHAR(10) NOT NULL,
    "nfcTagId" UUID,
    "skuId" UUID,
    "counter" INTEGER,
    "result" "VerificationResult" NOT NULL,
    "reasonCode" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NfcVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CogsReconciliation_reconciliationNumber_key" ON "CogsReconciliation"("reconciliationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ExceptionCase_exceptionCode_key" ON "ExceptionCase"("exceptionCode");

-- CreateIndex
CREATE INDEX "ExceptionCase_status_slaDeadline_idx" ON "ExceptionCase"("status", "slaDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "NfcTag_nfcTagCode_key" ON "NfcTag"("nfcTagCode");

-- CreateIndex
CREATE UNIQUE INDEX "NfcTag_tagUidHash_key" ON "NfcTag"("tagUidHash");

-- CreateIndex
CREATE INDEX "NfcTag_skuId_idx" ON "NfcTag"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "NfcVerification_verificationCode_key" ON "NfcVerification"("verificationCode");

-- CreateIndex
CREATE INDEX "NfcVerification_skuId_createdAt_idx" ON "NfcVerification"("skuId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPrice_productId_variantId_marketId_effectiveFrom_key" ON "ProductPrice"("productId", "variantId", "marketId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_currentNfcTagId_key" ON "Sku"("currentNfcTagId");

-- AddForeignKey
ALTER TABLE "BlockchainLedger" ADD CONSTRAINT "BlockchainLedger_nfcTagId_fkey" FOREIGN KEY ("nfcTagId") REFERENCES "NfcTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CogsReconciliation" ADD CONSTRAINT "CogsReconciliation_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_currentNfcTagId_fkey" FOREIGN KEY ("currentNfcTagId") REFERENCES "NfcTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_supplyBatchId_fkey" FOREIGN KEY ("supplyBatchId") REFERENCES "SupplyBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcTag" ADD CONSTRAINT "NfcTag_supplyBatchId_fkey" FOREIGN KEY ("supplyBatchId") REFERENCES "SupplyBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcTag" ADD CONSTRAINT "NfcTag_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcVerification" ADD CONSTRAINT "NfcVerification_nfcTagId_fkey" FOREIGN KEY ("nfcTagId") REFERENCES "NfcTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcVerification" ADD CONSTRAINT "NfcVerification_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyBatch" ADD CONSTRAINT "SupplyBatch_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_nfcTagId_fkey" FOREIGN KEY ("nfcTagId") REFERENCES "NfcTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

