-- ============================================================================
-- Remove the batch-key design (NfcKeySet). Every chip now has its own keys in
-- NfcTagKey, and no tag URL carries `b` any more.
--
-- DESTRUCTIVE, approved by the project owner: drops the NfcKeySet table (one
-- dev row, key set 786), NfcTag.keySetId and NfcVerification.keySetId. Nothing
-- else is touched — written by hand so that unrelated drift in the shared dev
-- database is not swept in.
-- ============================================================================

-- DropForeignKey
ALTER TABLE "NfcKeySet" DROP CONSTRAINT "NfcKeySet_supplyBatchId_fkey";

-- DropForeignKey
ALTER TABLE "NfcTag" DROP CONSTRAINT "NfcTag_keySetId_fkey";

-- DropIndex
DROP INDEX "NfcTag_keySetId_idx";

-- AlterTable
ALTER TABLE "NfcTag" DROP COLUMN "keySetId";

-- AlterTable
ALTER TABLE "NfcVerification" DROP COLUMN "keySetId";

-- DropTable
DROP TABLE "NfcKeySet";

-- DropEnum
DROP TYPE "NfcKeySetStatus";
