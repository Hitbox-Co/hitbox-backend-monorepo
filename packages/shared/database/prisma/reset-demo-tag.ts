/**
 * Reset the demo tag back to UNCLAIMED (keeps the product + its "First Time"
 * origin ledger record). Use between demos so the next tap claims fresh.
 *
 * Run: pnpm --filter @hitbox/database exec tsx prisma/reset-demo-tag.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TAG_ID = '534A70C1610001';

async function main() {
    const product = await prisma.product.findUnique({ where: { tagId: TAG_ID } });
    if (!product) {
        console.log(`tag ${TAG_ID} not provisioned — nothing to reset`);
        return;
    }
    const id = product.id;
    // Order matters for FKs: CLAIM ledger rows (→ claims) first, then claims.
    await prisma.blockchainLedger.deleteMany({ where: { originProductId: id, sequenceNo: { gt: 0 } } });
    await prisma.productClaim.deleteMany({ where: { productId: id } });
    await prisma.buyerCollection.deleteMany({ where: { productId: id } });
    await prisma.productHistory.deleteMany({ where: { productId: id } });
    await prisma.product.update({
        where: { id },
        data: { claimedStatus: 'UNCLAIMED', ownerId: null, claimedAt: null },
    });
    console.log(`✔ reset ${TAG_ID} → UNCLAIMED (origin ledger record kept)`);
}

main()
    .catch((err) => { console.error('✖ reset failed:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
