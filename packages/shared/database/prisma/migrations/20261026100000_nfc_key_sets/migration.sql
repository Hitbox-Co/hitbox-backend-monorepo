-- ============================================================================
-- NFC KEY SETS (batch keys for NTAG 424 DNA secure unique NFC messages)
--
-- One NfcKeySet per batch of chips. Every chip in the set carries the same
-- Key 00 / Key 01 / Key 02. The tap URL names the set with `b`, the verifier
-- unwraps Key 01 to decrypt `e` and Key 02 to check `c`.
--
-- Keys are stored ONLY wrapped by the cloud KMS (BYTEA columns hold the
-- wrapped blob, never a plaintext key).
--
-- NfcTag.lastTapCounter now defaults to -1 ("never tapped") so a first tap
-- reporting counter 0 counts as an increase. The DEFAULT applies to new rows
-- only; existing rows are left exactly as they are.
-- ============================================================================

-- CreateEnum
CREATE TYPE "NfcKeySetStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateTable
CREATE TABLE "NfcKeySet" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "keySetCode" VARCHAR(20) NOT NULL,
    "supplyBatchId" UUID,
    "key0Wrapped" BYTEA NOT NULL,
    "key1Wrapped" BYTEA NOT NULL,
    "key2Wrapped" BYTEA NOT NULL,
    "kmsKeyRef" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "NfcKeySetStatus" NOT NULL DEFAULT 'ACTIVE',
    "retiredAt" TIMESTAMP(3),
    "retireReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NfcKeySet_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "NfcTag" ADD COLUMN "keySetId" UUID;
ALTER TABLE "NfcTag" ALTER COLUMN "lastTapCounter" SET DEFAULT -1;

-- CreateIndex
CREATE UNIQUE INDEX "NfcKeySet_publicCode_key" ON "NfcKeySet"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "NfcKeySet_keySetCode_key" ON "NfcKeySet"("keySetCode");

-- CreateIndex
CREATE INDEX "NfcKeySet_supplyBatchId_idx" ON "NfcKeySet"("supplyBatchId");

-- CreateIndex
CREATE INDEX "NfcTag_keySetId_idx" ON "NfcTag"("keySetId");

-- AddForeignKey
ALTER TABLE "NfcKeySet" ADD CONSTRAINT "NfcKeySet_supplyBatchId_fkey" FOREIGN KEY ("supplyBatchId") REFERENCES "SupplyBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcTag" ADD CONSTRAINT "NfcTag_keySetId_fkey" FOREIGN KEY ("keySetId") REFERENCES "NfcKeySet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
