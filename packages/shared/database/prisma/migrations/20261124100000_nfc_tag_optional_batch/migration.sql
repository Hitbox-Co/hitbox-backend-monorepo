-- A chip can now be added straight to a unit (the SKU routes), with no consignment.
-- Existing chips all have a batch, so this only relaxes the constraint.
ALTER TABLE "NfcTag" ALTER COLUMN "supplyBatchId" DROP NOT NULL;
