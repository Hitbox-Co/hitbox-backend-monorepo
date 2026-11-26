-- Drop content (docs/content/drop-content.md), part 1 of 2.
-- A new enum value cannot be used in the transaction that adds it, so the
-- table and index that use it are in the next migration.
ALTER TYPE "ContentAccessType" ADD VALUE 'SKU_EXCLUSIVE';
