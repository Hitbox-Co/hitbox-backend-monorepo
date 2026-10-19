-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'INR', 'GBP');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('PENDING', 'CLEARED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "AddressLabel" AS ENUM ('HOME', 'WORK', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'MANAGE', 'APPROVE', 'REJECT', 'PUBLISH', 'REFUND', 'CLAIM', 'TRANSFER', 'ASSIGN', 'EXPORT', 'CONFIGURE', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('SELF_PROFILE', 'BUYER_PROFILE', 'DROP', 'RELEASE_APPROVAL', 'COLLECTIBLE_INSTANCE', 'REPORTS_DASHBOARDS', 'MY_COLLECTIONS', 'ORDER', 'PAYMENT_ROYALTY', 'CONTENT_UNLOCK', 'NFC_TAG_CLAIM', 'BRAND_ARTIST_RECORD', 'EMPLOYEE_ROLE_MGMT', 'AUDIT_LOG', 'NOTIFICATION_CONFIG', 'SEARCH_DISCOVER', 'OPS_DASHBOARD_INFRA', 'PLATFORM_CONFIG', 'ASSETS_DOCUMENTS_UPLOAD', 'GENERAL_LOCATION', 'AGE_SPECIFIC_FLAG', 'ADDRESS');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('GLOBAL', 'ORG', 'OWN');

-- CreateEnum
CREATE TYPE "RoleScopeType" AS ENUM ('ORG', 'OWN', 'GLOBAL');

-- CreateEnum
CREATE TYPE "ArtistBrandLinkType" AS ENUM ('PRIMARY', 'MERCHANDISE', 'DISTRIBUTION');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('BUYER', 'BRAND_EMPLOYEE', 'ARTIST', 'HITBOX_EMPLOYEE', 'HITBOX_ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditActionResult" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LedgerTxType" AS ENUM ('MINT', 'CLAIM', 'TRANSFER', 'FLAG', 'UNFLAG');

-- CreateEnum
CREATE TYPE "AcquisitionMethod" AS ENUM ('CLAIM', 'TRANSFER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ContentAccessType" AS ENUM ('OWNER_ONLY', 'EVOLUTION_GRANT', 'REWARD_GRANT');

-- CreateEnum
CREATE TYPE "EvolutionThresholdType" AS ENUM ('OWNED_DURATION', 'CLAIM_COUNT', 'PURCHASE_COUNT', 'TRADE_COUNT', 'LOCATION', 'EVENT_SPECIFIC');

-- CreateEnum
CREATE TYPE "RoyaltyBasis" AS ENUM ('NET_PROFIT', 'GROSS_REVENUE');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ORIGINAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "FinanceDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('DROP_IMAGE', 'PROFILE_IMAGE', 'EXCLUSIVE_CONTENT', 'LEGAL_DOCUMENT', 'SUPPLY_SPREADSHEET', 'OTHER');

-- CreateEnum
CREATE TYPE "VirusScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AddressUsage" AS ENUM ('SHIPPING', 'BILLING');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'COMMITTED', 'RELEASED');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('HITBOX', 'BRAND', 'ARTIST_INDIVIDUAL');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "GatewayConfigScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'DROP');

-- CreateEnum
CREATE TYPE "ConfigStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'AWAITING_RETURN', 'APPROVED', 'PROCESSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DropStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ACTIVE', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductPriceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResaleStatus" AS ENUM ('ACTIVE', 'SOLD', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "IndexOperation" AS ENUM ('UPSERT', 'DELETE', 'FULL_REINDEX');

-- CreateEnum
CREATE TYPE "IndexJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ClaimedStatus" AS ENUM ('UNCLAIMED', 'CLAIMED', 'IN_TRANSFER', 'FLAGGED');

-- CreateEnum
CREATE TYPE "TagLifecycleState" AS ENUM ('UNPROVISIONED', 'BOUND', 'ACTIVE', 'LOST', 'REVOKED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "VendorType" AS ENUM ('NFC_TAG_MANUFACTURER', 'MERCHANDISE_MANUFACTURER', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplyItemType" AS ENUM ('NFC_TAG', 'MERCHANDISE');

-- CreateEnum
CREATE TYPE "SupportCaseType" AS ENUM ('LOST', 'DAMAGED', 'STOLEN', 'CLONED', 'DISPUTE');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER');

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "entityGroup" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL,
    "resource" "ResourceType" NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "fieldAllowlist" TEXT[],
    "isInferred" BOOLEAN NOT NULL,
    "sourceCitation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "scopeType" "RoleScopeType" NOT NULL,
    "scopeId" UUID,
    "grantedById" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artist" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "coverUrl" TEXT,
    "genre" TEXT,
    "isPublic" BOOLEAN NOT NULL,
    "organizationId" UUID,
    "userId" UUID,
    "complianceAttestedAt" TIMESTAMP(3),
    "complianceAttestedBy" UUID,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistCollection" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "heroImageUrl" TEXT,
    "position" INTEGER NOT NULL,
    "artistId" UUID NOT NULL,
    "organizationId" UUID,
    "isPublic" BOOLEAN NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistBrandLink" (
    "id" UUID NOT NULL,
    "artistId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "linkType" "ArtistBrandLinkType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistBrandLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEventType" (
    "eventType" TEXT NOT NULL,
    "personaGroup" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultSeverity" "AuditSeverity" NOT NULL,
    "sourceStories" TEXT[],
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEventType_pkey" PRIMARY KEY ("eventType")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "eventId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "actorRoleSnapshot" TEXT,
    "organizationId" UUID,
    "resourceType" TEXT,
    "resourceId" UUID,
    "actionResult" "AuditActionResult" NOT NULL,
    "severity" "AuditSeverity" NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceId" TEXT,
    "correlationId" UUID NOT NULL,
    "ledgerReferenceId" UUID,
    "metadata" JSONB NOT NULL,
    "insertedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("eventId","occurredAt")
);

-- CreateTable
CREATE TABLE "AuditRetentionPolicy" (
    "severity" "AuditSeverity" NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,

    CONSTRAINT "AuditRetentionPolicy_pkey" PRIMARY KEY ("severity")
);

-- CreateTable
CREATE TABLE "AuthWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductClaim" (
    "id" UUID NOT NULL,
    "claimCode" TEXT NOT NULL,
    "claimedNo" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "artistId" UUID,
    "collectionId" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "ProductClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockchainLedger" (
    "id" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "sequenceNo" INTEGER NOT NULL,
    "previousHash" TEXT,
    "currentHash" TEXT NOT NULL,
    "txType" "LedgerTxType" NOT NULL,
    "sellerDigitalSignature" TEXT,
    "buyerDigitalSignature" TEXT,
    "receiverPublicKey" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockchainLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductHistory" (
    "id" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "ownerId" UUID,
    "acquiredVia" "AcquisitionMethod" NOT NULL,
    "price" DECIMAL(12,2),
    "currency" "Currency",
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL,

    CONSTRAINT "ProductHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerCollection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "visibility" "Visibility" NOT NULL,
    "shareToken" TEXT,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "BuyerCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentBundle" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "productId" UUID,
    "collectionId" UUID,
    "accessType" "ContentAccessType" NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentBundleItem" (
    "id" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ContentBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentUnlock" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "skuId" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "accessExpiresAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL,

    CONSTRAINT "ContentUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionRule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "collectionId" UUID,
    "productId" UUID,
    "thresholdType" "EvolutionThresholdType" NOT NULL,
    "thresholdValue" INTEGER NOT NULL,
    "thresholdConfig" JSONB,
    "grantsBundleId" UUID,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionEvent" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "artistId" UUID,
    "collectionId" UUID,
    "productId" UUID,
    "basis" "RoyaltyBasis" NOT NULL,
    "splitType" TEXT NOT NULL,
    "splitConfig" JSONB NOT NULL,
    "percentage" DECIMAL(6,3),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoyaltyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyLedgerEntry" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "adjustsEntryId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoyaltyLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceLedgerEntry" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "entryType" "LedgerEntryType" NOT NULL,
    "direction" "FinanceDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "costOfGoods" DECIMAL(12,2),
    "gatewayFee" DECIMAL(12,2),
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "isDefault" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCountry" (
    "id" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "countryCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketCountry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "storageRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "virusScanStatus" "VirusScanStatus" NOT NULL,
    "uploadedById" UUID NOT NULL,
    "organizationId" UUID,
    "artistId" UUID,
    "productId" UUID,
    "collectionId" UUID,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "parameters" TEXT[],
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "payload" JSONB,
    "status" "NotificationStatus" NOT NULL,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "skuId" UUID,
    "quantity" INTEGER NOT NULL,
    "organizationId" UUID,
    "marketId" UUID,
    "status" "OrderStatus" NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "trackingNote" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAddress" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "usage" "AddressUsage" NOT NULL,
    "sourceAddressId" UUID,
    "label" "AddressLabel" NOT NULL,
    "labelCustom" TEXT,
    "recipientName" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReservation" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "gatewayRef" TEXT,
    "status" "PaymentTransactionStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "needsReview" BOOLEAN NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGatewayConfig" (
    "id" UUID NOT NULL,
    "scope" "GatewayConfigScope" NOT NULL,
    "organizationId" UUID,
    "gateway" "PaymentGateway" NOT NULL,
    "isDefault" BOOLEAN NOT NULL,
    "credentialsRef" TEXT NOT NULL,
    "status" "ConfigStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGatewayConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentGateway" NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "physicalReturnConfirmedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "gatewayRefundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "isFeatureFlag" BOOLEAN NOT NULL,
    "description" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "groupCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "collectionId" UUID,
    "artistId" UUID,
    "organizationId" UUID,
    "vertical" TEXT,
    "category" TEXT,
    "rarity" TEXT,
    "purchaseLimit" INTEGER,
    "totalSupply" INTEGER NOT NULL,
    "releaseStart" TIMESTAMP(3),
    "releaseEnd" TIMESTAMP(3),
    "status" "DropStatus" NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "complianceStatus" "ComplianceStatus" NOT NULL,
    "oddsDisclosureRef" TEXT,
    "isAgeSpecific" BOOLEAN NOT NULL,
    "minimumAge" INTEGER,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "optionValue" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "totalSupply" INTEGER,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL,
    "altText" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPrice" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "marketId" UUID NOT NULL,
    "amount" DECIMAL(12,2),
    "isFree" BOOLEAN NOT NULL,
    "costOfGoods" DECIMAL(12,2),
    "status" "ProductPriceStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseApproval" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "approverId" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "comment" TEXT,
    "version" INTEGER NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "complianceStatus" "ComplianceStatus" NOT NULL,
    "oddsDisclosureRef" TEXT,
    "checkedById" UUID,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResaleListing" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "ResaleStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResaleListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchIndexJob" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID,
    "operation" "IndexOperation" NOT NULL,
    "status" "IndexJobStatus" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SearchIndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sku" (
    "id" UUID NOT NULL,
    "skuCode" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "serialNumber" INTEGER NOT NULL,
    "ownerId" UUID,
    "claimedStatus" "ClaimedStatus" NOT NULL,
    "tagId" TEXT,
    "provisioningBatchId" TEXT,
    "tagLifecycleState" "TagLifecycleState" NOT NULL,
    "vendorId" UUID,
    "vendorAuthenticatedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimTokenIssuedAt" TIMESTAMP(3),
    "claimTokenUsedAt" TIMESTAMP(3),
    "resaleBlocked" BOOLEAN NOT NULL,
    "resaleBlockedReason" TEXT,
    "lastTapCounter" INTEGER NOT NULL,
    "tamperStatus" TEXT,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" UUID NOT NULL,
    "followerId" UUID NOT NULL,
    "artistId" UUID,
    "followedOrganizationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "notifyOnAvailable" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "vendorType" "VendorType" NOT NULL,
    "contactEmail" TEXT,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyBatch" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "itemType" "SupplyItemType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batchRef" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sourceFileRef" TEXT,
    "enteredById" UUID NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "skuId" UUID,
    "tagId" TEXT,
    "caseType" "SupportCaseType" NOT NULL,
    "status" "SupportCaseStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "handle" TEXT,
    "fullName" TEXT,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "role" "UserRole" NOT NULL,
    "profileVisibility" "Visibility" NOT NULL,
    "generalLocation" TEXT,
    "preferredMarketId" UUID,
    "isActive" BOOLEAN NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" "AddressLabel" NOT NULL,
    "labelCustom" TEXT,
    "recipientName" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "phone" TEXT,
    "isDefaultShipping" BOOLEAN NOT NULL,
    "isDefaultBilling" BOOLEAN NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_resource_action_scope_key" ON "Permission"("resource", "action", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_userId_roleId_scopeType_scopeId_key" ON "RoleAssignment"("userId", "roleId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_slug_key" ON "Artist"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_userId_key" ON "Artist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistCollection_slug_key" ON "ArtistCollection"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistBrandLink_artistId_organizationId_linkType_key" ON "ArtistBrandLink"("artistId", "organizationId", "linkType");

-- CreateIndex
CREATE UNIQUE INDEX "ProductClaim_claimCode_key" ON "ProductClaim"("claimCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductClaim_skuId_claimedNo_key" ON "ProductClaim"("skuId", "claimedNo");

-- CreateIndex
CREATE UNIQUE INDEX "BlockchainLedger_skuId_sequenceNo_key" ON "BlockchainLedger"("skuId", "sequenceNo");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerCollection_shareToken_key" ON "BuyerCollection"("shareToken");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerCollection_userId_skuId_key" ON "BuyerCollection"("userId", "skuId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBundleItem_bundleId_assetId_key" ON "ContentBundleItem"("bundleId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentUnlock_userId_bundleId_skuId_key" ON "ContentUnlock"("userId", "bundleId", "skuId");

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionEvent_ruleId_skuId_key" ON "EvolutionEvent"("ruleId", "skuId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_code_key" ON "Market"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCountry_countryCode_key" ON "MarketCountry"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_eventType_key" ON "NotificationTemplate"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_channel_key" ON "NotificationPreference"("userId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAddress_orderId_usage_key" ON "OrderAddress"("orderId", "usage");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_idempotencyKey_key" ON "PaymentTransaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformConfig_key_key" ON "PlatformConfig"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Product_groupCode_key" ON "Product"("groupCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_variantCode_key" ON "ProductVariant"("variantCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_optionName_optionValue_key" ON "ProductVariant"("productId", "optionName", "optionValue");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_assetId_key" ON "ProductImage"("productId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPrice_productId_variantId_marketId_key" ON "ProductPrice"("productId", "variantId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_skuCode_key" ON "Sku"("skuCode");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_tagId_key" ON "Sku"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_claimToken_key" ON "Sku"("claimToken");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_productId_serialNumber_key" ON "Sku"("productId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_artistId_key" ON "Follow"("followerId", "artistId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followedOrganizationId_key" ON "Follow"("followerId", "followedOrganizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_userId_productId_variantId_key" ON "WishlistItem"("userId", "productId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistCollection" ADD CONSTRAINT "ArtistCollection_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistCollection" ADD CONSTRAINT "ArtistCollection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBrandLink" ADD CONSTRAINT "ArtistBrandLink_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBrandLink" ADD CONSTRAINT "ArtistBrandLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_eventType_fkey" FOREIGN KEY ("eventType") REFERENCES "AuditEventType"("eventType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductClaim" ADD CONSTRAINT "ProductClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductClaim" ADD CONSTRAINT "ProductClaim_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductClaim" ADD CONSTRAINT "ProductClaim_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductClaim" ADD CONSTRAINT "ProductClaim_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductClaim" ADD CONSTRAINT "ProductClaim_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockchainLedger" ADD CONSTRAINT "BlockchainLedger_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCollection" ADD CONSTRAINT "BuyerCollection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCollection" ADD CONSTRAINT "BuyerCollection_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBundle" ADD CONSTRAINT "ContentBundle_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBundle" ADD CONSTRAINT "ContentBundle_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBundleItem" ADD CONSTRAINT "ContentBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "ContentBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBundleItem" ADD CONSTRAINT "ContentBundleItem_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentUnlock" ADD CONSTRAINT "ContentUnlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentUnlock" ADD CONSTRAINT "ContentUnlock_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "ContentBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentUnlock" ADD CONSTRAINT "ContentUnlock_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionRule" ADD CONSTRAINT "EvolutionRule_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionRule" ADD CONSTRAINT "EvolutionRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionRule" ADD CONSTRAINT "EvolutionRule_grantsBundleId_fkey" FOREIGN KEY ("grantsBundleId") REFERENCES "ContentBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionEvent" ADD CONSTRAINT "EvolutionEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EvolutionRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionEvent" ADD CONSTRAINT "EvolutionEvent_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyRule" ADD CONSTRAINT "RoyaltyRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyRule" ADD CONSTRAINT "RoyaltyRule_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyRule" ADD CONSTRAINT "RoyaltyRule_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyRule" ADD CONSTRAINT "RoyaltyRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyLedgerEntry" ADD CONSTRAINT "RoyaltyLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyLedgerEntry" ADD CONSTRAINT "RoyaltyLedgerEntry_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RoyaltyRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketCountry" ADD CONSTRAINT "MarketCountry_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "NotificationTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_sourceAddressId_fkey" FOREIGN KEY ("sourceAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentGatewayConfig" ADD CONSTRAINT "PaymentGatewayConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ArtistCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseApproval" ADD CONSTRAINT "ReleaseApproval_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseApproval" ADD CONSTRAINT "ReleaseApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseApproval" ADD CONSTRAINT "ReleaseApproval_checkedById_fkey" FOREIGN KEY ("checkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResaleListing" ADD CONSTRAINT "ResaleListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResaleListing" ADD CONSTRAINT "ResaleListing_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyBatch" ADD CONSTRAINT "SupplyBatch_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyBatch" ADD CONSTRAINT "SupplyBatch_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_preferredMarketId_fkey" FOREIGN KEY ("preferredMarketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
