-- ============================================================================
-- PER-TAG NFC KEYS: every NTAG 424 DNA chip gets its own Key 00/01/02.
--
-- Additive only: one new enum, one new table, one nullable column on the
-- verification log. No existing row or column is changed or removed. NfcTag
-- itself gets no column (the `keys` relation is Prisma-only).
-- ============================================================================

-- CreateEnum
CREATE TYPE "NfcTagKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "NfcVerification" ADD COLUMN     "nfcTagKeyId" UUID;

-- CreateTable
CREATE TABLE "NfcTagKey" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "nfcTagId" UUID NOT NULL,
    "key0Wrapped" BYTEA NOT NULL,
    "key1Wrapped" BYTEA NOT NULL,
    "key2Wrapped" BYTEA NOT NULL,
    "kmsKeyRef" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "NfcTagKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastTapCounter" INTEGER NOT NULL DEFAULT -1,
    "lastTapAt" TIMESTAMP(3),
    "personalizedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NfcTagKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NfcTagKey_publicCode_key" ON "NfcTagKey"("publicCode");

-- CreateIndex
CREATE INDEX "NfcTagKey_nfcTagId_status_idx" ON "NfcTagKey"("nfcTagId", "status");

-- At most one ACTIVE key row per tag (Prisma cannot express a partial index).
CREATE UNIQUE INDEX "NfcTagKey_one_active_per_tag" ON "NfcTagKey"("nfcTagId") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "NfcTagKey" ADD CONSTRAINT "NfcTagKey_nfcTagId_fkey" FOREIGN KEY ("nfcTagId") REFERENCES "NfcTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
