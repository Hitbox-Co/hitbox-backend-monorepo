-- HitBox v3.1.1 — rename the Product* tables to match their Prisma models.
--
-- v3.1 renamed the models and kept the physical names behind @@map. This drops
-- the aliases and renames the tables, the enum type and two columns for real,
-- so every Prisma name is now the database name.
--
-- ── Why this is hand-written ────────────────────────────────────────────────
--
-- `prisma migrate dev` CANNOT express a rename. Given this schema change it
-- emits DROP TABLE + CREATE TABLE, which would destroy every row in six tables.
-- Everything below is ALTER ... RENAME: catalog-only, no data read or copied,
-- constant time regardless of table size, and fully transactional.
--
-- ── What this does NOT do ───────────────────────────────────────────────────
--
-- No data is touched. Every row, index, constraint, foreign key and default
-- survives with its contents intact — only the names change.
--
-- ⚠️ This IS a breaking change for anything addressing these tables by name
-- from outside Prisma: raw SQL, BI tools, saved queries, external readers.
-- Inside this repo the three raw-SQL sites were updated in the same change.

-- ── 1. Tables ───────────────────────────────────────────────────────────────
ALTER TABLE "Product"        RENAME TO "Drop";
ALTER TABLE "ProductVariant" RENAME TO "DropVariant";
ALTER TABLE "ProductPrice"   RENAME TO "DropPrice";
ALTER TABLE "ProductImage"   RENAME TO "DropImage";
ALTER TABLE "ProductClaim"   RENAME TO "SkuClaim";
ALTER TABLE "ProductHistory" RENAME TO "SkuHistory";

-- ── 2. Enum type ────────────────────────────────────────────────────────────
ALTER TYPE "ProductPriceStatus" RENAME TO "DropPriceStatus";

-- ── 3. Columns whose Prisma field was renamed with the model ────────────────
ALTER TABLE "DropPrice" RENAME COLUMN "productId"     TO "dropId";
ALTER TABLE "Invoice"   RENAME COLUMN "productCostId" TO "dropPriceId";

-- ── 4. Constraint and index names ───────────────────────────────────────────
-- Postgres keeps the old names after a table rename, so `Drop` would still
-- carry `Product_pkey`. Prisma derives expected names from the table, so
-- leaving them behind means permanent drift: every `migrate diff` would want to
-- rename them, and the next `migrate dev` would try to drop and recreate them.
--
-- Prefix-swapped generically rather than listed one by one — there are 68 of
-- them across the six tables, counting the NOT NULL constraints, and a
-- hand-written list is a place to make a typo.
DO $$
DECLARE
    pair   text[];
    pairs  text[][] := ARRAY[
        -- Longest first: 'Product' would otherwise match 'ProductVariant'.
        ARRAY['ProductVariant', 'DropVariant'],
        ARRAY['ProductHistory', 'SkuHistory'],
        ARRAY['ProductClaim',   'SkuClaim'],
        ARRAY['ProductPrice',   'DropPrice'],
        ARRAY['ProductImage',   'DropImage'],
        ARRAY['Product',        'Drop']
    ];
    row    record;
    target text;
BEGIN
    FOREACH pair SLICE 1 IN ARRAY pairs LOOP
        -- Constraints: primary keys, foreign keys, uniques, NOT NULLs.
        FOR row IN
            SELECT c.conname, r.relname AS tbl
            FROM pg_constraint c
            JOIN pg_class r ON r.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = r.relnamespace
            WHERE n.nspname = 'public'
              AND r.relname = pair[2]
              AND c.conname LIKE pair[1] || '\_%'
        LOOP
            target := pair[2] || substring(row.conname from length(pair[1]) + 1);
            EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                           row.tbl, row.conname, target);
        END LOOP;

        -- Standalone indexes (a unique index not backed by a constraint).
        FOR row IN
            SELECT i.relname AS idx
            FROM pg_class i
            JOIN pg_namespace n ON n.oid = i.relnamespace
            JOIN pg_index x ON x.indexrelid = i.oid
            JOIN pg_class t ON t.oid = x.indrelid
            WHERE n.nspname = 'public'
              AND t.relname = pair[2]
              AND i.relname LIKE pair[1] || '\_%'
        LOOP
            target := pair[2] || substring(row.idx from length(pair[1]) + 1);
            EXECUTE format('ALTER INDEX %I RENAME TO %I', row.idx, target);
        END LOOP;
    END LOOP;
END $$;

-- ── 5. The three names that carry the renamed column, not just the table ────
ALTER TABLE "DropPrice"
    RENAME CONSTRAINT "DropPrice_productId_fkey" TO "DropPrice_dropId_fkey";
ALTER TABLE "DropPrice"
    RENAME CONSTRAINT "DropPrice_productId_not_null" TO "DropPrice_dropId_not_null";
ALTER INDEX "DropPrice_productId_variantId_marketId_effectiveFrom_key"
    RENAME TO "DropPrice_dropId_variantId_marketId_effectiveFrom_key";
