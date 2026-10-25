-- ============================================================================
-- Vendor portal.
--
-- A system admin invites people to a vendor; they set a password through the
-- ordinary staff-invitation sign-up and then book consignments and register
-- chip manifests — but only against drops the admin assigned to their vendor.
--
--   * VendorMember          — who may act for a vendor (invited → active → revoked)
--   * VendorDropAssignment  — which drops a vendor may supply
--   * ResourceType.VENDOR_SUPPLY — for the `vendor-supply:*:own` permissions held
--     by the new VENDOR role. Re-run `pnpm db:seed:authz` after deploying.
--   * AuditActorType.VENDOR — vendor-portal writes are recorded as the vendor.
--
-- Entirely additive. See docs/vendor/.
-- ============================================================================

-- AlterEnum
ALTER TYPE "ResourceType" ADD VALUE IF NOT EXISTS 'VENDOR_SUPPLY';

-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE IF NOT EXISTS 'VENDOR';

-- CreateEnum
CREATE TYPE "VendorMemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "VendorMember" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "invitationId" UUID,
    "userId" UUID,
    "status" "VendorMemberStatus" NOT NULL DEFAULT 'INVITED',
    "invitedById" UUID NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDropAssignment" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "dropId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorDropAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorMember_invitationId_key" ON "VendorMember"("invitationId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorMember_userId_key" ON "VendorMember"("userId");

-- CreateIndex
CREATE INDEX "VendorMember_vendorId_status_idx" ON "VendorMember"("vendorId", "status");

-- CreateIndex
CREATE INDEX "VendorMember_email_idx" ON "VendorMember"("email");

-- CreateIndex
CREATE UNIQUE INDEX "VendorDropAssignment_vendorId_dropId_key" ON "VendorDropAssignment"("vendorId", "dropId");

-- CreateIndex
CREATE INDEX "VendorDropAssignment_dropId_idx" ON "VendorDropAssignment"("dropId");

-- AddForeignKey
ALTER TABLE "VendorMember" ADD CONSTRAINT "VendorMember_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorMember" ADD CONSTRAINT "VendorMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorMember" ADD CONSTRAINT "VendorMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDropAssignment" ADD CONSTRAINT "VendorDropAssignment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDropAssignment" ADD CONSTRAINT "VendorDropAssignment_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Drop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDropAssignment" ADD CONSTRAINT "VendorDropAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
