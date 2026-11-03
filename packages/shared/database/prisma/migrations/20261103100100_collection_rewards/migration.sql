-- Collection rewards (docs/content/collection-rewards.md), part 2 of 2.

-- A display title per reward item.
ALTER TABLE "ContentBundleItem" ADD COLUMN "title" VARCHAR(200);

-- One collection reward per artist collection. Archiving keeps the row (and
-- the buyers' unlocks); turning it back on reuses it.
CREATE UNIQUE INDEX "ContentBundle_collection_reward_key"
    ON "ContentBundle" ("collectionId")
    WHERE "accessType" = 'COLLECTION_COMPLETE';

-- One grant per buyer per bundle when no single SKU earned it. The table's
-- own unique includes skuId, and Postgres treats NULLs as distinct, so
-- without this two concurrent evaluations could both insert.
CREATE UNIQUE INDEX "ContentUnlock_user_bundle_unsku_key"
    ON "ContentUnlock" ("userId", "bundleId")
    WHERE "skuId" IS NULL;
