-- COGS / Sales Price versioning + payout rejection trail.
-- Additive only: one new table, three nullable columns. No renames, no drops.

-- ── DropPricing ────────────────────────────────────────────────────────────
CREATE TABLE "DropPricing" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "dropId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "costOfGoods" DECIMAL(12,2) NOT NULL,
    "costOfGoodsInr" DECIMAL(12,2) NOT NULL,
    "salesPriceUsd" DECIMAL(12,2) NOT NULL,
    "salesPriceInr" DECIMAL(12,2) NOT NULL,
    -- Computed by the database so they can never disagree with the inputs.
    "grossProfitUsd" DECIMAL(12,2) GENERATED ALWAYS AS ("salesPriceUsd" - "costOfGoods") STORED,
    "grossProfitInr" DECIMAL(12,2) GENERATED ALWAYS AS ("salesPriceInr" - "costOfGoodsInr") STORED,
    "status" "DropPriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "costSource" TEXT,
    "varianceReason" TEXT,
    "createdById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DropPricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DropPricing_publicCode_key" ON "DropPricing"("publicCode");
CREATE UNIQUE INDEX "DropPricing_dropId_version_key" ON "DropPricing"("dropId", "version");
CREATE INDEX "DropPricing_dropId_effectiveFrom_idx" ON "DropPricing"("dropId", "effectiveFrom");

-- ── RoyaltyPayout rejection trail ──────────────────────────────────────────
ALTER TABLE "RoyaltyPayout"
    ADD COLUMN "rejectedById" UUID,
    ADD COLUMN "rejectedAt" TIMESTAMP(3),
    ADD COLUMN "rejectionReason" TEXT;
