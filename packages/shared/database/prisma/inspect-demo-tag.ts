/** Dump every row stored for the demo tag across all tables. */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TAG = '534A70C1610001';

async function main() {
    const product = await prisma.product.findUnique({
        where: { tagId: TAG },
        include: { owner: { select: { id: true, username: true, email: true } } },
    });
    if (!product) { console.log('tag not provisioned'); return; }

    const [claims, ledger, history, collections] = await Promise.all([
        prisma.productClaim.findMany({ where: { productId: product.id } }),
        prisma.blockchainLedger.findMany({ where: { originProductId: product.id }, orderBy: { sequenceNo: 'asc' } }),
        prisma.productHistory.findMany({ where: { productId: product.id } }),
        prisma.buyerCollection.findMany({ where: { productId: product.id } }),
    ]);

    const out = {
        'products (1 row)': {
            id: product.id, productCode: product.productCode, tagId: product.tagId,
            state: product.state, claimedStatus: product.claimedStatus,
            ownerId: product.ownerId, owner: product.owner,
            claimedAt: product.claimedAt, price: String(product.priceInDollars),
        },
        [`product_claims (${claims.length})`]: claims.map((c) => ({
            id: c.id, claimCode: c.claimCode, claimedNo: c.claimedNo, userId: c.userId, claimedAt: c.claimedAt,
        })),
        [`blockchain_ledger (${ledger.length})`]: ledger.map((l) => ({
            seq: l.sequenceNo, txType: l.txType, owner: l.originOwner, toUserId: l.toUserId,
            hash: l.productBuyerHash.slice(0, 16) + '…', previousHash: l.previousHash ? l.previousHash.slice(0, 16) + '…' : null,
            claimId: l.claimId,
        })),
        [`product_history (${history.length})`]: history.map((h) => ({
            ownerId: h.ownerId, price: h.price ? String(h.price) : null,
            start: h.ownershipStartDate, end: h.ownershipEndDate,
        })),
        [`buyer_collections (${collections.length})`]: collections.map((b) => ({
            userId: b.userId, visibility: b.visibility, genre: b.genre, totalClaimedNo: b.totalClaimedNo,
        })),
    };
    console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
