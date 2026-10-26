-- Order status history (append-only) and shipments with tracking numbers.
-- docs/orders/order-history-and-shipments.md

CREATE TYPE "OrderStatusSource" AS ENUM ('CHECKOUT', 'PAYMENT', 'ADMIN', 'PACKING', 'SHIPMENT', 'NFC_CLAIM', 'REFUND', 'CHECKOUT_SWEEP', 'BACKFILL');
CREATE TYPE "ShipmentStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "DeliveryConfirmation" AS ENUM ('ADMIN', 'NFC_CLAIM');

CREATE TABLE "OrderStatusHistory" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "source" "OrderStatusSource" NOT NULL,
    "actorId" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderStatusHistory_publicCode_key" ON "OrderStatusHistory"("publicCode");
CREATE INDEX "OrderStatusHistory_orderId_occurredAt_idx" ON "OrderStatusHistory"("orderId", "occurredAt");
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "OrderShipment" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "orderId" UUID NOT NULL,
    "carrierName" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "trackingUrl" TEXT,
    "note" TEXT,
    "status" "ShipmentStatus" NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "deliveredVia" "DeliveryConfirmation",
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderShipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderShipment_publicCode_key" ON "OrderShipment"("publicCode");
CREATE INDEX "OrderShipment_orderId_status_idx" ON "OrderShipment"("orderId", "status");
CREATE INDEX "OrderShipment_trackingNumber_idx" ON "OrderShipment"("trackingNumber");
ALTER TABLE "OrderShipment" ADD CONSTRAINT "OrderShipment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing orders get one row saying where they stood when history began, so
-- no order has an empty timeline. Their earlier steps were never recorded and
-- are not invented here.
INSERT INTO "OrderStatusHistory" ("id", "orderId", "fromStatus", "toStatus", "source", "actorId", "reason", "occurredAt")
SELECT gen_random_uuid(), o."id", NULL, o."status", 'BACKFILL', NULL,
       'Status when order history began; earlier steps were not recorded', o."updatedAt"
  FROM "Order" o;
