/**
 * Provision the demo NFC tag so it can be claimed.
 *
 * Creates one product carrying tagId = 534A70C1610001 (idempotent) plus its
 * "First Time" origin ledger record (owner = HitBox). Safe to re-run — if the
 * tag already exists it does nothing.
 *
 * Run: pnpm --filter @hitbox/database exec tsx prisma/provision-demo-tag.ts
 */
import { createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const TAG_ID = '534A70C1610001';
const PRODUCT_CODE = '534470000001'; // 12 digits
const ledgerHash = (productCode: string, tag: string, ownerId: string, dt: Date): string =>
    createHash('sha256').update([productCode, tag, ownerId, dt.toISOString()].join('+')).digest('hex');

async function main() {
    const existing = await prisma.product.findUnique({ where: { tagId: TAG_ID } });
    if (existing) {
        console.log(`✔ tag ${TAG_ID} already provisioned → product ${existing.id} (${existing.claimedStatus})`);
        return;
    }

    const product = await prisma.product.create({
        data: {
            productCode: PRODUCT_CODE,
            name: 'HitBox Demo Collectible',
            type: 'INDIVIDUAL',
            category: 'TRADING_CARD',
            genre: 'MUSIC',
            rarity: 'RARE',
            description: 'Demo collectible for the NFC tap-to-claim flow.',
            priceInDollars: new Prisma.Decimal('49.99'),
            inventoryUnit: 1,
            tagId: TAG_ID,
            claimedStatus: 'UNCLAIMED',
            images: { create: [{ url: 'https://picsum.photos/seed/hitbox-demo/600', title: 'cover' }] },
        },
    });

    const originDateTime = product.createdAt;
    await prisma.blockchainLedger.create({
        data: {
            txType: 'MINT',
            sequenceNo: 0,
            originDateTime,
            originOwner: 'HitBox',
            sellerDigitalSignature: `sig_hitbox_${PRODUCT_CODE}`,
            productBuyerHash: ledgerHash(PRODUCT_CODE, TAG_ID, 'HitBox', originDateTime),
            previousHash: null,
            transactionDateTime: originDateTime,
            transactionAmount: new Prisma.Decimal(0),
            originProductId: product.id,
        },
    });

    console.log(`✔ provisioned tag ${TAG_ID} → product ${product.id} (UNCLAIMED) + origin ledger record`);
}

main()
    .catch((err) => { console.error('✖ provisioning failed:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
