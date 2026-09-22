-- Release approvals: who is entitled to sign one off, and their acceptance of
-- the legal compliance terms.
--
-- Before this, any holder of `release-approval:manage` could approve any drop.
-- Now the drop's owner decides: an artist-individual drop needs the artist, a
-- brand's drop needs the brand, and a HitBox administrator cannot stand in for
-- either — the approval carries a legal acceptance only the owner can give.

CREATE TYPE "ApprovalAuthority" AS ENUM ('ARTIST', 'ORGANIZATION', 'PLATFORM');

ALTER TABLE "ReleaseApproval"
    -- Resolved from the drop's owner when the review opens and frozen, so a
    -- drop later moving between a brand and an artist cannot retroactively
    -- change who was accountable for a sign-off already given.
    ADD COLUMN "authority"                 "ApprovalAuthority",
    ADD COLUMN "requiredArtistId"          UUID,
    ADD COLUMN "requiredOrganizationId"    UUID,

    -- The approver accepting liability. Separate from `complianceStatus`,
    -- which is the platform's assessment of the drop rather than a person's
    -- acceptance of it.
    ADD COLUMN "legalComplianceAccepted"   BOOLEAN,
    ADD COLUMN "legalComplianceAcceptedAt" TIMESTAMP(3),
    ADD COLUMN "legalComplianceVersion"    TEXT,

    -- An administrator sending a rejected drop back for another decision.
    ADD COLUMN "reopenedFromVersion"       INTEGER,
    ADD COLUMN "reopenedById"              UUID,
    ADD COLUMN "reopenedAt"                TIMESTAMP(3),
    ADD COLUMN "reopenReason"              TEXT;

-- Existing rows predate the rule. PLATFORM is the honest backfill: they were
-- decided by HitBox staff under the old model, and claiming retrospectively
-- that an artist signed them off would be a lie in the compliance trail.
UPDATE "ReleaseApproval" SET "authority" = 'PLATFORM' WHERE "authority" IS NULL;
UPDATE "ReleaseApproval" SET "legalComplianceAccepted" = false WHERE "legalComplianceAccepted" IS NULL;

ALTER TABLE "ReleaseApproval"
    ALTER COLUMN "authority" SET NOT NULL,
    ALTER COLUMN "legalComplianceAccepted" SET NOT NULL;

ALTER TABLE "ReleaseApproval"
    ADD CONSTRAINT "ReleaseApproval_requiredArtistId_fkey"
        FOREIGN KEY ("requiredArtistId") REFERENCES "Artist"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ReleaseApproval_requiredOrganizationId_fkey"
        FOREIGN KEY ("requiredOrganizationId") REFERENCES "Organization"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ReleaseApproval_reopenedById_fkey"
        FOREIGN KEY ("reopenedById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per (drop, version). The service already computed version as
-- max+1, but nothing stopped two concurrent submissions landing on the same
-- number and silently forking the review history.
CREATE UNIQUE INDEX "ReleaseApproval_productId_version_key"
    ON "ReleaseApproval"("productId", "version");
