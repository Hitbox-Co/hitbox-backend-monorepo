-- ============================================================================
-- Vendor supply, variant by variant.
--
-- A drop's goods arrive as variants — a red T-shirt drop is 100 S, 100 M,
-- 100 L — and each chip is embedded in one of them. So:
--
--   * VendorVariantAllotment — how many of each variant a vendor is to supply
--   * VendorDropAssignment.quantity — the cap for a drop WITHOUT variants
--   * SupplyBatchLine — a consignment's per-variant breakdown and row counters
--   * NfcTag.variantId — which variant's goods the chip is embedded in
--
-- Entirely additive. Existing consignments keep no lines and existing chips no
-- variant; both stay valid. See docs/vendor/.
-- ============================================================================

-- AlterTable
ALTER TABLE "VendorDropAssignment" ADD COLUMN "quantity" INTEGER,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "NfcTag" ADD COLUMN "variantId" UUID;

-- CreateTable
CREATE TABLE "VendorVariantAllotment" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorVariantAllotment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyBatchLine" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rowsReceived" INTEGER NOT NULL DEFAULT 0,
    "rowsAccepted" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplyBatchLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorVariantAllotment_assignmentId_variantId_key" ON "VendorVariantAllotment"("assignmentId", "variantId");

-- CreateIndex
CREATE INDEX "VendorVariantAllotment_variantId_idx" ON "VendorVariantAllotment"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplyBatchLine_batchId_variantId_key" ON "SupplyBatchLine"("batchId", "variantId");

-- CreateIndex
CREATE INDEX "SupplyBatchLine_variantId_idx" ON "SupplyBatchLine"("variantId");

-- CreateIndex
CREATE INDEX "NfcTag_variantId_idx" ON "NfcTag"("variantId");

-- AddForeignKey
ALTER TABLE "VendorVariantAllotment" ADD CONSTRAINT "VendorVariantAllotment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VendorDropAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorVariantAllotment" ADD CONSTRAINT "VendorVariantAllotment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "DropVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyBatchLine" ADD CONSTRAINT "SupplyBatchLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SupplyBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyBatchLine" ADD CONSTRAINT "SupplyBatchLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "DropVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NfcTag" ADD CONSTRAINT "NfcTag_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "DropVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
