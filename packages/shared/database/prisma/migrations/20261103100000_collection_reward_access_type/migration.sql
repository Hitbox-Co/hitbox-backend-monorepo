-- Collection rewards (docs/content/collection-rewards.md), part 1 of 2.
-- A new enum value cannot be used in the transaction that adds it, so the
-- indexes that filter on it are in the next migration.
ALTER TYPE "ContentAccessType" ADD VALUE 'COLLECTION_COMPLETE';
