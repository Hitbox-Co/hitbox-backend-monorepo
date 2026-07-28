-- CreateEnum
CREATE TYPE "LedgerTxType" AS ENUM ('MINT', 'CLAIM', 'TRANSFER');

-- AlterTable
-- sequence_no is required with no schema default; add with a temporary default
-- to backfill any existing rows, then drop the default to match the schema.
ALTER TABLE "blockchain_ledger" ADD COLUMN     "sequence_no" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "blockchain_ledger" ALTER COLUMN "sequence_no" DROP DEFAULT;

ALTER TABLE "blockchain_ledger" ADD COLUMN     "tx_type" "LedgerTxType" NOT NULL DEFAULT 'MINT';
ALTER TABLE "blockchain_ledger" ADD COLUMN     "previous_hash" TEXT;
ALTER TABLE "blockchain_ledger" ADD COLUMN     "from_user_id" TEXT;
ALTER TABLE "blockchain_ledger" ADD COLUMN     "to_user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_ledger_origin_product_id_sequence_no_key" ON "blockchain_ledger"("origin_product_id", "sequence_no");

-- AddForeignKey
ALTER TABLE "blockchain_ledger" ADD CONSTRAINT "blockchain_ledger_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_ledger" ADD CONSTRAINT "blockchain_ledger_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
