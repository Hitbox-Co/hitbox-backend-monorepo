-- CreateEnum
CREATE TYPE "StaffInvitationStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('GST', 'SALES_TAX', 'EXEMPT');

-- CreateEnum
CREATE TYPE "TaxConfigurationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'VOID', 'CORRECTED');

-- CreateEnum
CREATE TYPE "TaxFilingType" AS ENUM ('GSTR_1', 'GSTR_3B', 'FORM_16A', 'FORM_1099_NEC', 'STATE_SALES_TAX');

-- CreateEnum
CREATE TYPE "TaxFilingStatus" AS ENUM ('PENDING', 'READY', 'FILED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ArtistTaxDocumentType" AS ENUM ('W9', 'PAN', 'GST_REGISTRATION', 'STATE_TAX_ID', 'FORM_1099_NEC_ISSUED', 'FORM_16A_ISSUED');

-- CreateEnum
CREATE TYPE "ArtistTaxDocumentStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TaxAdjustmentType" AS ENUM ('TAX_CORRECTION', 'REFUND', 'EXEMPTION_GRANTED');

-- CreateEnum
CREATE TYPE "TaxAdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "roleId" UUID NOT NULL,
    "scopeType" "RoleScopeType" NOT NULL,
    "scopeId" UUID,
    "status" "StaffInvitationStatus" NOT NULL,
    "providerInvitationId" VARCHAR(100),
    "providerError" TEXT,
    "invitedById" UUID NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" UUID,
    "assignmentId" UUID,
    "revokedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxConfiguration" (
    "id" UUID NOT NULL,
    "productId" UUID,
    "countryCode" VARCHAR(2) NOT NULL,
    "stateCode" VARCHAR(2),
    "taxType" "TaxType" NOT NULL,
    "taxRate" DECIMAL(6,3) NOT NULL,
    "hsnCode" VARCHAR(20),
    "sacCode" VARCHAR(20),
    "exemptionReason" VARCHAR(200),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" "TaxConfigurationStatus" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "invoiceNumber" VARCHAR(50) NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "fiscalYear" VARCHAR(10) NOT NULL,
    "orderId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "organizationId" UUID,
    "countryCode" VARCHAR(2) NOT NULL,
    "stateCode" VARCHAR(2),
    "currency" "Currency" NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "taxType" "TaxType" NOT NULL,
    "taxRate" DECIMAL(6,3) NOT NULL,
    "hsnCode" VARCHAR(20),
    "supplierName" VARCHAR(200) NOT NULL,
    "supplierAddress" TEXT NOT NULL,
    "supplierGstin" VARCHAR(20),
    "supplierPan" VARCHAR(20),
    "supplierEin" VARCHAR(20),
    "customerName" VARCHAR(200) NOT NULL,
    "customerEmail" VARCHAR(320) NOT NULL,
    "customerAddress" TEXT,
    "customerGstin" VARCHAR(20),
    "salesPriceSnapshot" DECIMAL(12,2),
    "productCostId" UUID,
    "pdfStorageRef" VARCHAR(500),
    "pdfSha256" VARCHAR(64),
    "pdfRenderedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "status" "InvoiceStatus" NOT NULL,
    "supersedesInvoiceId" UUID,
    "voidReason" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "productId" UUID,
    "skuId" UUID,
    "hsnCode" VARCHAR(20),
    "sacCode" VARCHAR(20),
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineSubtotal" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(6,3) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceNumberSequence" (
    "id" UUID NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "fiscalYear" VARCHAR(10) NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReturnFiling" (
    "id" UUID NOT NULL,
    "filingType" "TaxFilingType" NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "stateCode" VARCHAR(2),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalTaxableAmount" DECIMAL(14,2),
    "totalTaxCollected" DECIMAL(14,2),
    "totalTaxDue" DECIMAL(14,2),
    "inputTaxCredit" DECIMAL(14,2),
    "currency" "Currency",
    "artistId" UUID,
    "payoutId" UUID,
    "status" "TaxFilingStatus" NOT NULL,
    "filedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "referenceNumber" VARCHAR(100),
    "documentStorageRef" VARCHAR(500),
    "notes" TEXT,
    "createdById" UUID,
    "filedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxReturnFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistTaxDocument" (
    "id" UUID NOT NULL,
    "artistId" UUID NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "documentType" "ArtistTaxDocumentType" NOT NULL,
    "documentStorageRef" VARCHAR(500),
    "documentSha256" VARCHAR(64),
    "documentNumber" VARCHAR(50),
    "issuerName" VARCHAR(200),
    "issueDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "ArtistTaxDocumentStatus" NOT NULL,
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMP(3),
    "backupWithholdingApplied" BOOLEAN NOT NULL,
    "backupWithholdingRate" DECIMAL(5,2),
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistTaxDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxAdjustmentEntry" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "adjustmentType" "TaxAdjustmentType" NOT NULL,
    "reason" TEXT NOT NULL,
    "originalTaxAmount" DECIMAL(12,2) NOT NULL,
    "adjustedTaxAmount" DECIMAL(12,2) NOT NULL,
    "adjustmentAmount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "TaxAdjustmentStatus" NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxAdjustmentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffInvitation_email_status_idx" ON "StaffInvitation"("email", "status");

-- CreateIndex
CREATE INDEX "StaffInvitation_status_invitedAt_idx" ON "StaffInvitation"("status", "invitedAt");

-- CreateIndex
CREATE INDEX "StaffInvitation_roleId_idx" ON "StaffInvitation"("roleId");

-- CreateIndex
CREATE INDEX "StaffInvitation_scopeId_idx" ON "StaffInvitation"("scopeId");

-- CreateIndex
CREATE INDEX "TaxConfiguration_countryCode_stateCode_effectiveFrom_idx" ON "TaxConfiguration"("countryCode", "stateCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "TaxConfiguration_productId_effectiveFrom_idx" ON "TaxConfiguration"("productId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "TaxConfiguration_status_effectiveTo_idx" ON "TaxConfiguration"("status", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "TaxConfiguration_productId_countryCode_stateCode_effectiveF_key" ON "TaxConfiguration"("productId", "countryCode", "stateCode", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE INDEX "Invoice_buyerId_invoiceDate_idx" ON "Invoice"("buyerId", "invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_countryCode_stateCode_invoiceDate_idx" ON "Invoice"("countryCode", "stateCode", "invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_fiscalYear_countryCode_idx" ON "Invoice"("fiscalYear", "countryCode");

-- CreateIndex
CREATE INDEX "Invoice_status_invoiceDate_idx" ON "Invoice"("status", "invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_invoiceDate_idx" ON "Invoice"("organizationId", "invoiceDate");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_hsnCode_idx" ON "InvoiceLineItem"("hsnCode");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineItem_invoiceId_position_key" ON "InvoiceLineItem"("invoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceNumberSequence_countryCode_fiscalYear_key" ON "InvoiceNumberSequence"("countryCode", "fiscalYear");

-- CreateIndex
CREATE INDEX "TaxReturnFiling_status_dueDate_idx" ON "TaxReturnFiling"("status", "dueDate");

-- CreateIndex
CREATE INDEX "TaxReturnFiling_countryCode_filingType_periodStart_idx" ON "TaxReturnFiling"("countryCode", "filingType", "periodStart");

-- CreateIndex
CREATE INDEX "TaxReturnFiling_artistId_filingType_idx" ON "TaxReturnFiling"("artistId", "filingType");

-- CreateIndex
CREATE UNIQUE INDEX "TaxReturnFiling_filingType_countryCode_stateCode_periodStar_key" ON "TaxReturnFiling"("filingType", "countryCode", "stateCode", "periodStart", "artistId");

-- CreateIndex
CREATE INDEX "ArtistTaxDocument_artistId_status_idx" ON "ArtistTaxDocument"("artistId", "status");

-- CreateIndex
CREATE INDEX "ArtistTaxDocument_expiresAt_idx" ON "ArtistTaxDocument"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistTaxDocument_artistId_documentType_countryCode_status_key" ON "ArtistTaxDocument"("artistId", "documentType", "countryCode", "status");

-- CreateIndex
CREATE INDEX "TaxAdjustmentEntry_invoiceId_idx" ON "TaxAdjustmentEntry"("invoiceId");

-- CreateIndex
CREATE INDEX "TaxAdjustmentEntry_status_approvedAt_idx" ON "TaxAdjustmentEntry"("status", "approvedAt");

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxConfiguration" ADD CONSTRAINT "TaxConfiguration_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxConfiguration" ADD CONSTRAINT "TaxConfiguration_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supersedesInvoiceId_fkey" FOREIGN KEY ("supersedesInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnFiling" ADD CONSTRAINT "TaxReturnFiling_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnFiling" ADD CONSTRAINT "TaxReturnFiling_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "RoyaltyPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnFiling" ADD CONSTRAINT "TaxReturnFiling_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnFiling" ADD CONSTRAINT "TaxReturnFiling_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistTaxDocument" ADD CONSTRAINT "ArtistTaxDocument_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistTaxDocument" ADD CONSTRAINT "ArtistTaxDocument_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistTaxDocument" ADD CONSTRAINT "ArtistTaxDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAdjustmentEntry" ADD CONSTRAINT "TaxAdjustmentEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAdjustmentEntry" ADD CONSTRAINT "TaxAdjustmentEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAdjustmentEntry" ADD CONSTRAINT "TaxAdjustmentEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

