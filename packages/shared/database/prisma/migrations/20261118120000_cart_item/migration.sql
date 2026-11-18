-- Mobile cart (docs/mobile-app/cart-api.md). One row per drop (and variant) a
-- buyer means to buy. Holds no stock and no price: both are read live, and
-- each row is checked out on its own through POST /checkout.

-- CreateTable
CREATE TABLE "CartItem" (
    "id" UUID NOT NULL,
    "publicCode" VARCHAR(32),
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_publicCode_key" ON "CartItem"("publicCode");

-- CreateIndex
CREATE INDEX "CartItem_userId_createdAt_idx" ON "CartItem"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_userId_productId_variantId_key" ON "CartItem"("userId", "productId", "variantId");

-- Postgres treats NULLs as distinct, so the unique index above does not stop
-- two no-variant rows for the same drop. This one does. Not expressible in
-- the Prisma schema, so it lives only here.
CREATE UNIQUE INDEX "CartItem_userId_productId_no_variant_key" ON "CartItem"("userId", "productId") WHERE "variantId" IS NULL;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Drop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "DropVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
