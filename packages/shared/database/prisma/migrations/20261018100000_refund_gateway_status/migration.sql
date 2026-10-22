-- Provider-side refund status, kept separate from the workflow status.
CREATE TYPE "RefundGatewayStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

ALTER TABLE "RefundRequest"
    ADD COLUMN "gatewayStatus" "RefundGatewayStatus",
    ADD COLUMN "gatewayFailureReason" TEXT,
    ADD COLUMN "gatewayStatusAt" TIMESTAMP(3);

-- Refunds processed before this existed were confirmed by an operator or the
-- provider at the time; record them as settled rather than unknown.
UPDATE "RefundRequest"
   SET "gatewayStatus" = 'SUCCEEDED', "gatewayStatusAt" = "processedAt"
 WHERE "status" = 'PROCESSED' AND "processedAt" IS NOT NULL;

CREATE INDEX "RefundRequest_gatewayStatus_idx" ON "RefundRequest"("gatewayStatus");
CREATE INDEX "RefundRequest_gatewayRefundId_idx" ON "RefundRequest"("gatewayRefundId");
