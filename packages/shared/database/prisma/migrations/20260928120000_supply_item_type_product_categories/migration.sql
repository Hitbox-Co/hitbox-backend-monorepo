-- ============================================================================
-- SupplyItemType becomes the same set of PRODUCT CATEGORIES as VendorType.
--
-- Why: the chip arrives already embedded in the goods, so "what is in this
-- carton" is answered by what the goods ARE — figures, jerseys, cards — not by
-- whether the carton carried chips. `NFC_TAG` described a consignment of loose
-- reels that this platform never receives, and `COLLECTIBLE` said only "a
-- finished serialized item", which is true of every category.
--
-- The values mirror `VendorType` and `Drop.category`, so "who makes our
-- jerseys", "which drops are jerseys" and "which cartons held jerseys" answer
-- with the same word.
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so removing the three old
-- values means recreating the type — which is why this is written by hand.
-- Companion to 20260928100000_vendor_type_product_categories.
--
-- ---------------------------------------------------------------------------
-- Data mapping
--
--   MERCHANDISE -> MERCHANDISE        same meaning, and the value survives
--   COLLECTIBLE -> the linked drop's category, when that category is one of
--                  the enum's values; otherwise OTHER
--   NFC_TAG     -> OTHER
--
-- COLLECTIBLE is the only row type carrying enough information to place
-- accurately, and only sometimes. `Drop.category` is a free-text `String?`
-- column, not an enum — the two vocabularies agree by convention, not by
-- constraint — so the join below accepts a value only when it matches the
-- enum exactly (case-insensitively) and falls back to OTHER otherwise. A
-- consignment with no drop, or a drop with a category nobody standardised,
-- lands in OTHER rather than being guessed into a category it may not be.
--
-- NFC_TAG maps to OTHER for the same reason the vendor migration mapped
-- NFC_TAG_MANUFACTURER to OTHER: a loose-chip consignment genuinely has no
-- product category, and inventing one would put a false fact in the table.
--
-- Re-classify by hand afterwards if it matters. This query lists what landed
-- in OTHER and why:
--
--   SELECT b.id, b."batchRef", d."category" AS drop_category
--     FROM "SupplyBatch" b
--     LEFT JOIN "Drop" d ON d.id = b."dropId"
--    WHERE b."itemType" = 'OTHER';
-- ============================================================================

-- 1. Step aside. The old type keeps every dependent column valid meanwhile.
ALTER TYPE "SupplyItemType" RENAME TO "SupplyItemType_old";

-- 2. The new type, identical in membership and order to VendorType.
CREATE TYPE "SupplyItemType" AS ENUM (
    'FIGURE',
    'KEYCHAIN',
    'JERSEY',
    'APPAREL',
    'TRADING_CARD',
    'POSTER',
    'PLUSH',
    'MERCHANDISE',
    'OTHER'
);

-- 3. A new column rather than `ALTER COLUMN ... USING`.
--
--    USING cannot reach another table, and COLLECTIBLE's mapping depends on
--    the row's drop. Translating in place would also collapse COLLECTIBLE and
--    NFC_TAG into OTHER in the same statement, after which the two are
--    indistinguishable and the drop-category refinement could no longer tell
--    which rows it was entitled to touch.
--
--    The column ends up last in the table's physical order. Postgres offers no
--    way to place it, and nothing here depends on ordinal position.
ALTER TABLE "SupplyBatch" ADD COLUMN "itemType_new" "SupplyItemType";

UPDATE "SupplyBatch" b
   SET "itemType_new" = (
        CASE b."itemType"::text
            WHEN 'MERCHANDISE' THEN 'MERCHANDISE'
            WHEN 'COLLECTIBLE' THEN COALESCE(
                (
                    SELECT upper(trim(d."category"))
                      FROM "Drop" d
                     WHERE d.id = b."dropId"
                       AND upper(trim(d."category")) IN (
                           'FIGURE', 'KEYCHAIN', 'JERSEY', 'APPAREL',
                           'TRADING_CARD', 'POSTER', 'PLUSH',
                           'MERCHANDISE', 'OTHER'
                       )
                ),
                'OTHER'
            )
            WHEN 'NFC_TAG' THEN 'OTHER'
            -- Exhaustive over the old type, and still carries an ELSE: a value
            -- added to the old enum after this file was written must not fail
            -- the cast at deploy time.
            ELSE 'OTHER'
        END
   )::"SupplyItemType";

-- 4. The column was NOT NULL before and stays so.
ALTER TABLE "SupplyBatch" ALTER COLUMN "itemType_new" SET NOT NULL;
ALTER TABLE "SupplyBatch" DROP COLUMN "itemType";
ALTER TABLE "SupplyBatch" RENAME COLUMN "itemType_new" TO "itemType";

-- 5. Nothing references the old type now.
DROP TYPE "SupplyItemType_old";
