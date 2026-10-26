/**
 * Test data for scan-to-assign (docs/orders/order-unit-assignment-api.md).
 *
 *   pnpm db:seed:test-tee            → 2 new PAID orders
 *   pnpm db:seed:test-tee -- 5       → 5 new PAID orders
 *
 * Creates, once (re-runs reuse it):
 *   - drop "Test Tour Tee" (groupCode TEST-TEE-01), type T_SHIRT, ACTIVE,
 *     HitBox-owned, variants S / M × Black / White;
 *   - an IN-market price on every variant;
 *   - 5 units per variant with test NFC tags bound (TEST-TEE-01-TAG-0001…),
 *     each with its MINT ledger record — minted through the real mint code;
 *   - a test buyer, test.buyer@hitbox.demo (a database row only, no Clerk login).
 *
 * Then places N orders for "M / Black" through the real checkout code
 * (placeOrder → markPaid), so each is PAID holding a PROVISIONAL placeholder
 * unit — exactly what a packer sees.
 *
 * Dev-only. It imports the skus, claims and orders repositories by relative
 * path so the test data goes through the same code as production, not a
 * hand-written copy of it.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/index';
import { SkuRepository } from '../../../skus/src/repository/sku.repository';
import { MintLedgerWriter } from '../../../claims/src/repository/mint-ledger.writer';
import { OrderWriteRepository } from '../../../orders/src/repository/order-write.repository';

const GROUP_CODE = 'TEST-TEE-01';
const UNITS_PER_VARIANT = 5;
const ORDER_VARIANT = { size: 'M', color: 'BLK' };
const BUYER_EMAIL = 'test.buyer@hitbox.demo';
const PRICE_INR = '1499.00';

const SIZES = ['S', 'M'];
const COLORS = ['BLK', 'WHT'];

async function ensureDrop(): Promise<string> {
    const existing = await prisma.drop.findUnique({ where: { groupCode: GROUP_CODE }, select: { id: true } });
    if (existing) {
        console.log(`• drop ${GROUP_CODE} already exists — reusing it`);
        return existing.id;
    }

    const type = await prisma.dropType.findUnique({
        where: { code: 'T_SHIRT' },
        include: { dimensions: { include: { values: true } } },
    });
    if (!type) throw new Error('Drop type T_SHIRT not found — run `pnpm db:seed:drop-types` first.');
    const valueOf = (dimension: string, code: string) => {
        const dim = type.dimensions.find((d) => d.code === dimension);
        const value = dim?.values.find((v) => v.code === code);
        if (!dim || !value) throw new Error(`T_SHIRT has no ${dimension}=${code}`);
        return { dim, value };
    };

    const market = await prisma.market.findUnique({ where: { code: 'IN' }, select: { id: true } });
    if (!market) throw new Error('Market IN not found.');

    const now = new Date();
    const dropId = randomUUID();
    const total = SIZES.length * COLORS.length * UNITS_PER_VARIANT;

    // 1. Drop, variants, options, prices — one transaction.
    const variantIds = new Map<string, string>();
    await prisma.$transaction(async (tx) => {
        await tx.drop.create({
            data: {
                id: dropId,
                groupCode: GROUP_CODE,
                name: 'Test Tour Tee',
                description: 'Test data for scan-to-assign. Safe to archive.',
                category: 'Apparel',
                totalSupply: total,
                status: 'ACTIVE',
                publishedAt: now,
                complianceStatus: 'CLEARED',
                isAgeSpecific: false,
                isActive: true,
                dropTypeId: type.id,
                dropTypeVersion: type.version,
                createdAt: now,
                updatedAt: now,
            },
        });

        let position = 0;
        for (const size of SIZES) {
            for (const color of COLORS) {
                const s = valueOf('size', size);
                const c = valueOf('color', color);
                const variantId = randomUUID();
                variantIds.set(`${size}-${color}`, variantId);
                await tx.dropVariant.create({
                    data: {
                        id: variantId,
                        productId: dropId,
                        variantCode: `${GROUP_CODE}-${size}-${color}`,
                        label: `${s.value.label} / ${c.value.label}`,
                        optionName: 'size/color',
                        optionValue: `${size}/${color}`,
                        optionsKey: `color=${color}|size=${size}`,
                        position: position++,
                        totalSupply: UNITS_PER_VARIANT,
                        isActive: true,
                        createdAt: now,
                        updatedAt: now,
                        options: {
                            create: [
                                { id: randomUUID(), dimensionCode: 'size', dimensionLabel: s.dim.label, valueCode: size, valueLabel: s.value.label, hexCode: null, position: s.dim.position, createdAt: now },
                                { id: randomUUID(), dimensionCode: 'color', dimensionLabel: c.dim.label, valueCode: color, valueLabel: c.value.label, hexCode: c.value.hexCode, position: c.dim.position, createdAt: now },
                            ],
                        },
                    },
                });
                await tx.dropPrice.create({
                    data: {
                        id: randomUUID(),
                        dropId,
                        variantId,
                        marketId: market.id,
                        amount: new Prisma.Decimal(PRICE_INR),
                        isFree: false,
                        costOfGoods: new Prisma.Decimal('400.00'),
                        status: 'ACTIVE',
                        effectiveFrom: new Date(now.getTime() - 60_000),
                        createdAt: now,
                        updatedAt: now,
                    },
                });
            }
        }
        // A drop-level base price too, so catalog listings show one.
        await tx.dropPrice.create({
            data: {
                id: randomUUID(), dropId, variantId: null, marketId: market.id,
                amount: new Prisma.Decimal(PRICE_INR), isFree: false, costOfGoods: new Prisma.Decimal('400.00'),
                status: 'ACTIVE', effectiveFrom: new Date(now.getTime() - 60_000), createdAt: now, updatedAt: now,
            },
        });
    }, { maxWait: 10_000, timeout: 60_000 }); // remote DB: many round trips

    // 2. Units per variant, with tags and MINT ledger rows — the real mint code,
    //    one transaction per variant so units and their MINT rows commit together.
    const skus = new SkuRepository(prisma);
    const ledger = new MintLedgerWriter();
    let tagNo = 1;
    for (const [key, variantId] of variantIds) {
        const tagIds = Array.from({ length: UNITS_PER_VARIANT }, () => `${GROUP_CODE}-TAG-${String(tagNo++).padStart(4, '0')}`);
        await prisma.$transaction(
            async (tx) => {
                const { units } = await skus.mintWithin(tx, {
                    productId: dropId,
                    groupCode: GROUP_CODE,
                    count: UNITS_PER_VARIANT,
                    variantId,
                    tagIds,
                } as never);
                await ledger.recordMintWithin(tx, { units, actorId: null });
            },
            { maxWait: 10_000, timeout: 20_000 },
        );
        console.log(`• minted ${UNITS_PER_VARIANT} × ${key} (tags ${tagIds[0]} … ${tagIds[tagIds.length - 1]})`);
    }

    console.log(`✔ created drop ${GROUP_CODE} (${dropId})`);
    return dropId;
}

async function ensureBuyer(): Promise<string> {
    const now = new Date();
    const user = await prisma.user.upsert({
        where: { email: BUYER_EMAIL },
        update: {},
        create: {
            id: randomUUID(),
            clerkId: 'user_test_buyer_hitbox_demo',
            email: BUYER_EMAIL,
            fullName: 'Test Buyer',
            handle: 'test-buyer',
            role: 'USER',
            profileVisibility: 'PRIVATE',
            isActive: true,
            createdAt: now,
            updatedAt: now,
        },
        select: { id: true },
    });
    return user.id;
}

async function main(): Promise<void> {
    const orderCount = Math.max(1, Number(process.argv[2] ?? 2) || 2);

    const dropId = await ensureDrop();
    const buyerId = await ensureBuyer();
    const variant = await prisma.dropVariant.findFirstOrThrow({
        where: { productId: dropId, optionsKey: `color=${ORDER_VARIANT.color}|size=${ORDER_VARIANT.size}` },
        select: { id: true, label: true },
    });
    const market = await prisma.market.findUniqueOrThrow({ where: { code: 'IN' }, select: { id: true } });

    // 3. Orders through the real checkout path: hold a placeholder, then settle.
    const orders = new OrderWriteRepository(prisma);
    const created: { orderId: string; placeholder: string }[] = [];
    for (let i = 0; i < orderCount; i += 1) {
        const now = new Date();
        const placed = await orders.placeOrder({
            buyerId,
            productId: dropId,
            variantId: variant.id,
            marketId: market.id,
            quantity: 1,
            holdSeconds: 900,
            termsAccepted: true,
            shippingAddressId: null,
            billingAddressId: null,
            now,
        });
        const paid = await orders.markPaid({ orderId: placed.orderId, settledAt: new Date() });
        if (!paid) throw new Error(`order ${placed.orderId} could not be marked PAID`);
        const sku = await prisma.sku.findUniqueOrThrow({ where: { id: placed.skuId }, select: { skuCode: true } });
        created.push({ orderId: placed.orderId, placeholder: sku.skuCode });
    }

    // What a packer can scan.
    const free = await prisma.sku.findMany({
        where: {
            productId: dropId,
            variantId: variant.id,
            claimedStatus: 'UNCLAIMED',
            orders: { none: {} },
            inventoryReservations: { none: { OR: [{ status: 'COMMITTED' }, { status: 'HELD', expiresAt: { gt: new Date() } }] } },
        },
        select: { skuCode: true, tagId: true },
        orderBy: { serialNumber: 'asc' },
    });
    const wrong = await prisma.sku.findFirst({
        where: { productId: dropId, NOT: { variantId: variant.id } },
        select: { skuCode: true, tagId: true, variant: { select: { label: true } } },
    });

    console.log(`\n✔ ${created.length} PAID order(s) for "${variant.label}" — buyer ${BUYER_EMAIL}`);
    for (const o of created) console.log(`  order ${o.orderId}   (provisional placeholder ${o.placeholder})`);
    console.log(`\nFree "${variant.label}" units you can scan for them:`);
    for (const s of free) console.log(`  tagId ${s.tagId}   skuCode ${s.skuCode}`);
    if (wrong) console.log(`\nWrong-item test (${wrong.variant?.label}): tagId ${wrong.tagId}`);
}

main()
    .catch((error) => {
        console.error('✖ test T-shirt order seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
