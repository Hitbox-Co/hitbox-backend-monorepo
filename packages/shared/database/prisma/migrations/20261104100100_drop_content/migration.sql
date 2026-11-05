-- Drop content (docs/content/drop-content.md), part 2 of 2.

-- The units of a drop that open a SKU_EXCLUSIVE bundle, by serial number.
CREATE TABLE "ContentBundleSerial" (
    "bundleId" UUID NOT NULL,
    "serialNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentBundleSerial_pkey" PRIMARY KEY ("bundleId","serialNumber")
);

ALTER TABLE "ContentBundleSerial" ADD CONSTRAINT "ContentBundleSerial_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "ContentBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One regular-content bundle per drop. Removing it keeps the row; saving it
-- again reuses it.
CREATE UNIQUE INDEX "ContentBundle_drop_regular_key"
    ON "ContentBundle" ("productId")
    WHERE "accessType" = 'OWNER_ONLY' AND "productId" IS NOT NULL;

-- "Which exclusive content does this drop have" — the buyer's and the
-- artist's read.
CREATE INDEX "ContentBundle_drop_exclusive_idx"
    ON "ContentBundle" ("productId")
    WHERE "accessType" = 'SKU_EXCLUSIVE';
