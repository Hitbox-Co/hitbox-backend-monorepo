-- ============================================================================
-- VendorType becomes a set of PRODUCT CATEGORIES.
--
-- Why: an NFC chip arrives already embedded in the item, so "NFC tag
-- manufacturer" is not a supplier category this platform actually buys from.
-- A vendor is the factory that makes the action figure, the keychain or the
-- jersey — and the values below deliberately mirror `Drop.category`, so
-- "who makes our jerseys" and "which drops are jerseys" answer with the same
-- word.
--
-- Postgres has NO `ALTER TYPE ... DROP VALUE`, so removing the two old values
-- means recreating the type. That is what this migration does, and it is why
-- it is written by hand rather than generated.
--
-- Data mapping:
--   MERCHANDISE_MANUFACTURER -> MERCHANDISE   (same meaning, new name)
--   NFC_TAG_MANUFACTURER     -> OTHER         (see the note below)
--
-- `NFC_TAG_MANUFACTURER` maps to OTHER rather than to a product category on
-- purpose: a chip supplier genuinely has no product category under the new
-- model, and guessing one would put a false fact in the table. Re-classify
-- those vendors by hand if they also make goods.
-- ============================================================================

-- 1. Step aside. The old type keeps every dependent column valid meanwhile.
ALTER TYPE "VendorType" RENAME TO "VendorType_old";

-- 2. The new type.
CREATE TYPE "VendorType" AS ENUM (
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

-- 3. Move the column across, translating every existing row.
--    The CASE is exhaustive over the old type and still carries an ELSE, so a
--    value added to the old enum after this file was written cannot silently
--    fail the cast at deploy time.
ALTER TABLE "Vendor"
    ALTER COLUMN "vendorType" TYPE "VendorType"
    USING (
        CASE "vendorType"::text
            WHEN 'MERCHANDISE_MANUFACTURER' THEN 'MERCHANDISE'
            WHEN 'NFC_TAG_MANUFACTURER'     THEN 'OTHER'
            ELSE 'OTHER'
        END
    )::"VendorType";

-- 4. Nothing references the old type now.
DROP TYPE "VendorType_old";
