/** Update the product on tag 534A70C1610001 with real details. */
import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();
const TAG = '534A70C1610001';

async function main() {
    const updated = await prisma.product.update({
        where: { tagId: TAG },
        data: {
            name: 'Subratadaschip',
            priceInDollars: new Prisma.Decimal(1000),
            inventoryUnit: 10,
            claimedStatus: 'UNCLAIMED',
        },
        select: { productCode: true, name: true, tagId: true, priceInDollars: true, inventoryUnit: true, claimedStatus: true },
    });
    console.log('✔ updated:', JSON.stringify({ ...updated, priceInDollars: String(updated.priceInDollars) }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
