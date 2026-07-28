/** Quick inventory of what's actually in the DB. */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const [products, users, artists, claims, ledger] = await Promise.all([
        prisma.product.findMany({ select: { id: true, productCode: true, name: true, tagId: true, claimedStatus: true } }),
        prisma.user.findMany({ select: { id: true, username: true, email: true, clerkUserId: true } }),
        prisma.artist.count(),
        prisma.productClaim.count(),
        prisma.blockchainLedger.count(),
    ]);
    console.log(`PRODUCTS (${products.length}):`);
    for (const p of products) console.log(`  ${p.productCode}  tag=${p.tagId ?? '—'}  ${p.claimedStatus}  "${p.name}"`);
    console.log(`\nUSERS (${users.length}):`);
    for (const u of users) console.log(`  ${u.email}  @${u.username ?? '—'}  clerk=${u.clerkUserId}`);
    console.log(`\nartists=${artists}  productClaims=${claims}  ledgerRows=${ledger}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
