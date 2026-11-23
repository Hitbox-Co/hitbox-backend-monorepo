-- Collectors following collectors (docs/mobile-app/follows-api.md). Follow
-- already held user → artist and user → organization; this adds user → user.

-- AlterTable
ALTER TABLE "Follow" ADD COLUMN "followedUserId" UUID;

-- CreateIndex
CREATE INDEX "Follow_followedUserId_idx" ON "Follow"("followedUserId");

-- CreateIndex
CREATE INDEX "Follow_artistId_idx" ON "Follow"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followedUserId_key" ON "Follow"("followerId", "followedUserId");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A follow points at exactly one thing. Every existing row (artist or
-- organization) already satisfies this. Not expressible in the Prisma schema.
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_exactly_one_target_chk"
    CHECK (num_nonnulls("artistId", "followedOrganizationId", "followedUserId") = 1);

-- Nobody follows themselves.
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_not_self_chk"
    CHECK ("followedUserId" IS NULL OR "followedUserId" <> "followerId");
