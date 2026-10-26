-- Buyer photo evidence on returns: RefundEvidence + AssetType.RETURN_EVIDENCE.
-- Additive only. docs/orders/order-payments-and-refunds-api.md §6.0

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'RETURN_EVIDENCE';

-- CreateTable
CREATE TABLE "RefundEvidence" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "refundRequestId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "attachedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundEvidence_publicCode_key" ON "RefundEvidence"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "RefundEvidence_mediaAssetId_key" ON "RefundEvidence"("mediaAssetId");

-- CreateIndex
CREATE INDEX "RefundEvidence_refundRequestId_position_idx" ON "RefundEvidence"("refundRequestId", "position");

-- AddForeignKey
ALTER TABLE "RefundEvidence" ADD CONSTRAINT "RefundEvidence_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundEvidence" ADD CONSTRAINT "RefundEvidence_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

