-- ============================================================================
-- NfcTagKey: keep the chip UID with its keys (encrypted + lookup hash).
--
-- Additive only: two nullable columns and one index, all on the NEW NfcTagKey
-- table (0 rows). The key service always writes both. Nothing existing changes.
-- ============================================================================

-- AlterTable
ALTER TABLE "NfcTagKey" ADD COLUMN     "tagUidEncrypted" TEXT,
ADD COLUMN     "tagUidHash" TEXT;

-- CreateIndex
CREATE INDEX "NfcTagKey_tagUidHash_idx" ON "NfcTagKey"("tagUidHash");
