-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('GROUP', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('TRADING_CARD', 'FIGURE', 'POSTER', 'BOOK', 'AUTOGRAPH', 'JERSEY', 'DIGITAL_ASSET', 'ACCESSORY', 'GAME_BOX', 'CARD_PACK', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductGenre" AS ENUM ('MUSIC', 'SPORTS', 'FILM', 'GAMING', 'PUBLICATION', 'ART', 'ANIME', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketplaceStatus" AS ENUM ('TRENDING_NOW', 'NEW_RELEASE', 'TOP_CREATORS');

-- CreateEnum
CREATE TYPE "ProductRarity" AS ENUM ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER');

-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProductState" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CollectionVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ClaimedStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');

-- CreateTable
CREATE TABLE "auth_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_claims" (
    "id" TEXT NOT NULL,
    "claimCode" VARCHAR(10) NOT NULL,
    "claimed_no" INTEGER NOT NULL DEFAULT 1,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "artist_id" TEXT,
    "collection_id" TEXT,

    CONSTRAINT "product_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_ledger" (
    "id" TEXT NOT NULL,
    "origin_date_time" TIMESTAMP(3) NOT NULL,
    "origin_owner" VARCHAR(255) NOT NULL,
    "seller_digital_signature" TEXT NOT NULL,
    "buyer_digital_signature" TEXT,
    "receiver_public_key" TEXT,
    "product_buyer_hash" TEXT NOT NULL,
    "transaction_date_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transaction_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "origin_product_id" TEXT NOT NULL,
    "claim_id" TEXT,

    CONSTRAINT "blockchain_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_collections" (
    "id" TEXT NOT NULL,
    "total_claimed_no" INTEGER NOT NULL DEFAULT 0,
    "genre" "ProductGenre",
    "visibility" "CollectionVisibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "buyer_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artists" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "bio" TEXT,
    "image_url" TEXT,
    "genre" "ProductGenre",
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_collections" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "cover_image_url" TEXT,
    "release_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "artist_id" TEXT NOT NULL,

    CONSTRAINT "artist_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "productCode" VARCHAR(12) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "ProductType" NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "genre" "ProductGenre" NOT NULL,
    "description" TEXT,
    "reward_points" INTEGER NOT NULL DEFAULT 0,
    "state" "ProductState" NOT NULL DEFAULT 'ACTIVE',
    "marketplace_status" "MarketplaceStatus",
    "rarity" "ProductRarity" NOT NULL DEFAULT 'COMMON',
    "price_in_dollars" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "inventory_unit" INTEGER NOT NULL DEFAULT 0,
    "units_sold" INTEGER NOT NULL DEFAULT 0,
    "tag_id" VARCHAR(64),
    "claimed_status" "ClaimedStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "claimed_at" TIMESTAMP(3),
    "release_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "owner_id" TEXT,
    "collection_id" TEXT,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_history" (
    "id" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "ownership_start_date" TIMESTAMP(3),
    "ownership_end_date" TIMESTAMP(3),
    "product_id" TEXT NOT NULL,
    "owner_id" TEXT,

    CONSTRAINT "product_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(255),
    "description" TEXT,
    "url" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "username" VARCHAR(50),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "avatar_url" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "state" "UserState" NOT NULL DEFAULT 'ACTIVE',
    "reward_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_webhook_events_processed_at_idx" ON "auth_webhook_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_claims_claimCode_key" ON "product_claims"("claimCode");

-- CreateIndex
CREATE INDEX "product_claims_user_id_idx" ON "product_claims"("user_id");

-- CreateIndex
CREATE INDEX "product_claims_product_id_idx" ON "product_claims"("product_id");

-- CreateIndex
CREATE INDEX "blockchain_ledger_origin_product_id_idx" ON "blockchain_ledger"("origin_product_id");

-- CreateIndex
CREATE INDEX "blockchain_ledger_claim_id_idx" ON "blockchain_ledger"("claim_id");

-- CreateIndex
CREATE INDEX "buyer_collections_user_id_idx" ON "buyer_collections"("user_id");

-- CreateIndex
CREATE INDEX "buyer_collections_product_id_idx" ON "buyer_collections"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_collections_user_id_product_id_key" ON "buyer_collections"("user_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "artists_slug_key" ON "artists"("slug");

-- CreateIndex
CREATE INDEX "artist_collections_artist_id_idx" ON "artist_collections"("artist_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_productCode_key" ON "products"("productCode");

-- CreateIndex
CREATE UNIQUE INDEX "products_tag_id_key" ON "products"("tag_id");

-- CreateIndex
CREATE INDEX "products_owner_id_idx" ON "products"("owner_id");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_genre_idx" ON "products"("genre");

-- CreateIndex
CREATE INDEX "products_marketplace_status_idx" ON "products"("marketplace_status");

-- CreateIndex
CREATE INDEX "product_history_product_id_idx" ON "product_history"("product_id");

-- CreateIndex
CREATE INDEX "product_history_owner_id_idx" ON "product_history"("owner_id");

-- CreateIndex
CREATE INDEX "product_images_product_id_idx" ON "product_images"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_user_id_key" ON "users"("clerk_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_state_idx" ON "users"("state");

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "artist_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_ledger" ADD CONSTRAINT "blockchain_ledger_origin_product_id_fkey" FOREIGN KEY ("origin_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_ledger" ADD CONSTRAINT "blockchain_ledger_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "product_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyer_collections" ADD CONSTRAINT "buyer_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyer_collections" ADD CONSTRAINT "buyer_collections_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_collections" ADD CONSTRAINT "artist_collections_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "artist_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_history" ADD CONSTRAINT "product_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_history" ADD CONSTRAINT "product_history_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
