-- Reward points on a drop. Set by HitBox System Admin only
-- (drop:configure:global); existing drops start at 0.
ALTER TABLE "Drop" ADD COLUMN "rewardPoints" INTEGER NOT NULL DEFAULT 0;

-- Never negative: a buyer cannot lose points by buying.
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_rewardPoints_nonnegative" CHECK ("rewardPoints" >= 0);
