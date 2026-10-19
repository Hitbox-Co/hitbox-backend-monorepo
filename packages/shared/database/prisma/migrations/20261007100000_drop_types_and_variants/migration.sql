-- ============================================================================
-- Drop types & multi-dimension variants.
--
-- A DropType declares which dimensions a variant varies along (size, color,
-- edition…), the values each may take — with an optional hex code for colors —
-- and the rules between them. A variant's options move from one name/value
-- pair to one DropVariantOption row per dimension.
--
-- Entirely additive. No column is dropped or retyped, and every existing drop
-- keeps working: `Drop.dropTypeId` is nullable, and a drop without a type is a
-- legacy drop to which no variant rules apply.
--
-- Backfill: each existing DropVariant gets
--   * optionsKey = 'legacy:<optionName>=<optionValue>' — unique per drop by
--     construction, because (productId, optionName, optionValue) already is;
--   * one DropVariantOption row carrying its original name/value pair.
--
-- `ResourceType.DROP_TYPE` is appended (metadata-only in Postgres) for the
-- new `drop-type:manage:global` permission. Re-run `pnpm db:seed:authz`.
--
-- See docs/admin/drop-types-and-variants.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "VariantMode" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');

-- CreateEnum
CREATE TYPE "DimensionDisplayType" AS ENUM ('TEXT', 'COLOR');

-- AlterEnum
ALTER TYPE "ResourceType" ADD VALUE IF NOT EXISTS 'DROP_TYPE';

-- AlterTable
ALTER TABLE "Drop" ADD COLUMN     "dropTypeId" UUID,
ADD COLUMN     "dropTypeVersion" INTEGER;

-- AlterTable
ALTER TABLE "DropVariant" ADD COLUMN     "optionsKey" TEXT;

-- CreateTable
CREATE TABLE "DropVariantOption" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "variantId" UUID NOT NULL,
    "dimensionCode" TEXT NOT NULL,
    "dimensionLabel" TEXT NOT NULL,
    "valueCode" TEXT NOT NULL,
    "valueLabel" TEXT NOT NULL,
    "hexCode" VARCHAR(7),
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropVariantOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DropType" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "variantMode" "VariantMode" NOT NULL,
    "variantCodePattern" TEXT NOT NULL DEFAULT '{groupCode}-{values}',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DropTypeDimension" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "dropTypeId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL,
    "allowCustomValues" BOOLEAN NOT NULL DEFAULT false,
    "displayType" "DimensionDisplayType" NOT NULL DEFAULT 'TEXT',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropTypeDimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DropTypeDimensionValue" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "dimensionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hexCode" VARCHAR(7),
    "position" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropTypeDimensionValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DropVariantOption_publicCode_key" ON "DropVariantOption"("publicCode");

-- CreateIndex
CREATE INDEX "DropVariantOption_dimensionCode_valueCode_idx" ON "DropVariantOption"("dimensionCode", "valueCode");

-- CreateIndex
CREATE UNIQUE INDEX "DropVariantOption_variantId_dimensionCode_key" ON "DropVariantOption"("variantId", "dimensionCode");

-- CreateIndex
CREATE UNIQUE INDEX "DropType_publicCode_key" ON "DropType"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "DropType_code_key" ON "DropType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DropTypeDimension_publicCode_key" ON "DropTypeDimension"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "DropTypeDimension_dropTypeId_code_key" ON "DropTypeDimension"("dropTypeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DropTypeDimensionValue_publicCode_key" ON "DropTypeDimensionValue"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "DropTypeDimensionValue_dimensionId_code_key" ON "DropTypeDimensionValue"("dimensionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DropVariant_productId_optionsKey_key" ON "DropVariant"("productId", "optionsKey");

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_dropTypeId_fkey" FOREIGN KEY ("dropTypeId") REFERENCES "DropType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DropVariantOption" ADD CONSTRAINT "DropVariantOption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "DropVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DropTypeDimension" ADD CONSTRAINT "DropTypeDimension_dropTypeId_fkey" FOREIGN KEY ("dropTypeId") REFERENCES "DropType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DropTypeDimensionValue" ADD CONSTRAINT "DropTypeDimensionValue_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "DropTypeDimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Backfill existing variants ──────────────────────────────────────────────

UPDATE "DropVariant"
SET "optionsKey" = 'legacy:' || "optionName" || '=' || "optionValue"
WHERE "optionsKey" IS NULL;

ALTER TABLE "DropVariant" ALTER COLUMN "optionsKey" SET NOT NULL;

INSERT INTO "DropVariantOption"
    ("id", "variantId", "dimensionCode", "dimensionLabel", "valueCode", "valueLabel", "position", "createdAt")
SELECT gen_random_uuid(), v."id", v."optionName", v."optionName", v."optionValue", v."optionValue", 0, v."createdAt"
FROM "DropVariant" v
WHERE NOT EXISTS (SELECT 1 FROM "DropVariantOption" o WHERE o."variantId" = v."id");
