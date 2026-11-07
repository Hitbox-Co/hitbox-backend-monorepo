-- ============================================================================
-- NFC VERIFICATION LOG: which key set checked each tap, and a per-tag index.
--
-- Additive only: one nullable column and one index. No existing row is
-- changed or removed. `keySetId` is deliberately NOT a foreign key, so the log
-- keeps the key set it was checked against even after that set is retired.
-- ============================================================================

-- AlterTable
ALTER TABLE "NfcVerification" ADD COLUMN     "keySetId" UUID;

-- CreateIndex
CREATE INDEX "NfcVerification_nfcTagId_createdAt_idx" ON "NfcVerification"("nfcTagId", "createdAt");
