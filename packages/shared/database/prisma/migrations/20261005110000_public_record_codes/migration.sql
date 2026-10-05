-- ============================================================================
-- HUMAN-READABLE RECORD IDS
--
-- Every table gains `publicCode`: a short, readable identifier such as
-- `odr0h2k9m4p7x3f8q2n6rt` (order) or `inv0h2k9m4qb1y7z4s` (invoice). The uuid
-- primary key is unchanged and every foreign key still points at it — this is
-- the string a person reads out, searches for, or quotes on a ticket.
--
-- NULLABLE on purpose. Postgres unique indexes do not collide on NULLs, so
-- this applies to a table with existing rows without a backfill and without
-- locking it to rewrite every row. New rows are stamped by the publicCode
-- client extension; pre-existing rows stay NULL until backfilled.
--
-- VARCHAR(32) leaves room for a 3-char prefix + 19-char body with headroom.
-- ============================================================================

ALTER TABLE "Role" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Permission" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RolePermission" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RoleAssignment" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "StaffInvitation" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ArtistCollection" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ArtistBrandLink" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "AuditEventType" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "AuditEvent" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "AuditRetentionPolicy" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "AuthWebhookEvent" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "SkuClaim" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "BlockchainLedger" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "SkuHistory" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "BuyerCollection" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ContentBundle" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ContentBundleItem" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ContentUnlock" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "EvolutionRule" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "EvolutionEvent" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RoyaltyRule" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RoyaltyLedgerEntry" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RoyaltyPayout" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "AdjustmentEntry" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "FinanceLedgerEntry" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "CogsReconciliation" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "MarketCountry" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "MediaAsset" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "NotificationTemplate" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "OrderAddress" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "InventoryReservation" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "PaymentTransaction" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "PaymentGatewayConfig" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "RefundRequest" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "DisputeCase" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "PlatformConfig" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ExceptionCase" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Drop" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "DropVariant" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "DropImage" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "DropPrice" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ReleaseApproval" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ResaleListing" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "SearchIndexJob" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "NfcVerification" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Follow" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "WishlistItem" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "SupplyBatch" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "NfcTag" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "SupportCase" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "TaxConfiguration" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "InvoiceLineItem" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "InvoiceNumberSequence" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "TaxReturnFiling" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "ArtistTaxDocument" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "TaxAdjustmentEntry" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);

-- Unique per table. A collision is then a failed insert rather than two
-- records quietly sharing a code.

CREATE UNIQUE INDEX IF NOT EXISTS "Role_publicCode_key" ON "Role"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Permission_publicCode_key" ON "Permission"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RolePermission_publicCode_key" ON "RolePermission"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RoleAssignment_publicCode_key" ON "RoleAssignment"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvitation_publicCode_key" ON "StaffInvitation"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Artist_publicCode_key" ON "Artist"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ArtistCollection_publicCode_key" ON "ArtistCollection"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ArtistBrandLink_publicCode_key" ON "ArtistBrandLink"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditEventType_publicCode_key" ON "AuditEventType"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditEvent_publicCode_key" ON "AuditEvent"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditRetentionPolicy_publicCode_key" ON "AuditRetentionPolicy"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "AuthWebhookEvent_publicCode_key" ON "AuthWebhookEvent"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "SkuClaim_publicCode_key" ON "SkuClaim"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "BlockchainLedger_publicCode_key" ON "BlockchainLedger"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "SkuHistory_publicCode_key" ON "SkuHistory"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "BuyerCollection_publicCode_key" ON "BuyerCollection"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ContentBundle_publicCode_key" ON "ContentBundle"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ContentBundleItem_publicCode_key" ON "ContentBundleItem"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ContentUnlock_publicCode_key" ON "ContentUnlock"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "EvolutionRule_publicCode_key" ON "EvolutionRule"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "EvolutionEvent_publicCode_key" ON "EvolutionEvent"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RoyaltyRule_publicCode_key" ON "RoyaltyRule"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RoyaltyLedgerEntry_publicCode_key" ON "RoyaltyLedgerEntry"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RoyaltyPayout_publicCode_key" ON "RoyaltyPayout"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "AdjustmentEntry_publicCode_key" ON "AdjustmentEntry"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "FinanceLedgerEntry_publicCode_key" ON "FinanceLedgerEntry"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "CogsReconciliation_publicCode_key" ON "CogsReconciliation"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Market_publicCode_key" ON "Market"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "MarketCountry_publicCode_key" ON "MarketCountry"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_publicCode_key" ON "MediaAsset"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationTemplate_publicCode_key" ON "NotificationTemplate"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_publicCode_key" ON "Notification"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPreference_publicCode_key" ON "NotificationPreference"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_publicCode_key" ON "Order"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "OrderAddress_publicCode_key" ON "OrderAddress"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryReservation_publicCode_key" ON "InventoryReservation"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_publicCode_key" ON "Organization"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_publicCode_key" ON "PaymentTransaction"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentGatewayConfig_publicCode_key" ON "PaymentGatewayConfig"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentWebhookEvent_publicCode_key" ON "PaymentWebhookEvent"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "RefundRequest_publicCode_key" ON "RefundRequest"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "DisputeCase_publicCode_key" ON "DisputeCase"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformConfig_publicCode_key" ON "PlatformConfig"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ExceptionCase_publicCode_key" ON "ExceptionCase"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Drop_publicCode_key" ON "Drop"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "DropVariant_publicCode_key" ON "DropVariant"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "DropImage_publicCode_key" ON "DropImage"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "DropPrice_publicCode_key" ON "DropPrice"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseApproval_publicCode_key" ON "ReleaseApproval"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ResaleListing_publicCode_key" ON "ResaleListing"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "SearchIndexJob_publicCode_key" ON "SearchIndexJob"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Sku_publicCode_key" ON "Sku"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "NfcVerification_publicCode_key" ON "NfcVerification"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Follow_publicCode_key" ON "Follow"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "WishlistItem_publicCode_key" ON "WishlistItem"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Vendor_publicCode_key" ON "Vendor"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "SupplyBatch_publicCode_key" ON "SupplyBatch"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "NfcTag_publicCode_key" ON "NfcTag"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "SupportCase_publicCode_key" ON "SupportCase"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "TaxConfiguration_publicCode_key" ON "TaxConfiguration"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_publicCode_key" ON "Invoice"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceLineItem_publicCode_key" ON "InvoiceLineItem"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceNumberSequence_publicCode_key" ON "InvoiceNumberSequence"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "TaxReturnFiling_publicCode_key" ON "TaxReturnFiling"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ArtistTaxDocument_publicCode_key" ON "ArtistTaxDocument"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "TaxAdjustmentEntry_publicCode_key" ON "TaxAdjustmentEntry"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "User_publicCode_key" ON "User"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Address_publicCode_key" ON "Address"("publicCode");
