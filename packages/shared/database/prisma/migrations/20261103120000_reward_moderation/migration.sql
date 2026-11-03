-- Staff moderation of collection rewards (docs/content/admin-rewards-api.md).
-- A lock set by HitBox switching a reward off or removing it; while set, the
-- artist cannot switch it on or restore it.
ALTER TABLE "ContentBundle" ADD COLUMN "moderationLockedAt" TIMESTAMP(3);
ALTER TABLE "ContentBundle" ADD COLUMN "moderationReason" VARCHAR(500);
ALTER TABLE "ContentBundle" ADD COLUMN "moderatedById" UUID;
