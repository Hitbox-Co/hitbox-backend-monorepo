-- US-P018 — Claim Integrity Controls.
-- Purely additive: one enum, one table, its indexes and two foreign keys.
-- Nothing existing is dropped or altered. Sku.claimToken* are now marked
-- @deprecated in the Prisma partial but the columns stay, and
-- Sku.claimTokenUsedAt is still written by the claim transaction.

-- CreateEnum
CREATE TYPE "ClaimTokenStatus" AS ENUM ('ISSUED', 'CONSUMED', 'LOST_TIEBREAK', 'SUPERSEDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ClaimToken" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "skuId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "ClaimTokenStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "claimId" UUID,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplayAt" TIMESTAMP(3),
    "requestId" TEXT,

    CONSTRAINT "ClaimToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimToken_tokenHash_key" ON "ClaimToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ClaimToken_skuId_issuedAt_idx" ON "ClaimToken"("skuId", "issuedAt");

-- CreateIndex
CREATE INDEX "ClaimToken_userId_skuId_status_idx" ON "ClaimToken"("userId", "skuId", "status");

-- CreateIndex
CREATE INDEX "ClaimToken_status_issuedAt_idx" ON "ClaimToken"("status", "issuedAt");

-- AddForeignKey
ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
