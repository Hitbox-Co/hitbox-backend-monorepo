-- Artist profiles created from a staff invitation.
--
-- An artist is invited before they have an account, so the profile is created
-- with `userId` NULL and this column is the only thing connecting it to the
-- person who was invited. When they accept, `userId` is filled in by matching
-- on this.
--
-- Nullable: every artist created by any other route (seed, direct insert, a
-- future admin "create artist" screen) has no invitation behind it.
ALTER TABLE "Artist" ADD COLUMN "invitationId" UUID;

-- Unique so replaying the invitation event cannot produce a second profile for
-- the same invitation. NULLs do not collide in a Postgres unique index, so any
-- number of non-invited artists remain legal.
CREATE UNIQUE INDEX "Artist_invitationId_key" ON "Artist"("invitationId");
