-- CreateEnum
CREATE TYPE "AuthorizationDomain" AS ENUM ('BUSINESS', 'TECHNICAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PermissionAction" ADD VALUE 'DEBUG';
ALTER TYPE "PermissionAction" ADD VALUE 'DEPLOY';
ALTER TYPE "PermissionAction" ADD VALUE 'RESTART';

-- AlterEnum
BEGIN;
CREATE TYPE "PermissionScope_new" AS ENUM ('GLOBAL', 'ORGANIZATION', 'OWN', 'PUBLIC', 'MASKED', 'MASKED_PARTIAL');
ALTER TABLE "Permission" ALTER COLUMN "scope" TYPE "PermissionScope_new" USING ("scope"::text::"PermissionScope_new");
ALTER TYPE "PermissionScope" RENAME TO "PermissionScope_old";
ALTER TYPE "PermissionScope_new" RENAME TO "PermissionScope";
DROP TYPE "public"."PermissionScope_old";
COMMIT;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ResourceType" ADD VALUE 'APPLICATION';
ALTER TYPE "ResourceType" ADD VALUE 'INFRASTRUCTURE';

-- AlterEnum
BEGIN;
CREATE TYPE "RoleScopeType_new" AS ENUM ('ORGANIZATION', 'OWN', 'GLOBAL');
ALTER TABLE "RoleAssignment" ALTER COLUMN "scopeType" TYPE "RoleScopeType_new" USING ("scopeType"::text::"RoleScopeType_new");
ALTER TYPE "RoleScopeType" RENAME TO "RoleScopeType_old";
ALTER TYPE "RoleScopeType_new" RENAME TO "RoleScopeType";
DROP TYPE "public"."RoleScopeType_old";
COMMIT;

-- AlterTable
ALTER TABLE "Permission" ADD COLUMN     "domain" "AuthorizationDomain" NOT NULL;

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "domain" "AuthorizationDomain" NOT NULL,
ADD COLUMN     "isSystem" BOOLEAN NOT NULL;

