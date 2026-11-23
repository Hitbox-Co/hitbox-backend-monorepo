import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { OrderLedgerAdapter } from '../src/domain/order-ledger.adapter';
import { OrderWriteRepository } from '../src/repository/order-write.repository';

/**
 * The checkout quote: price and availability with no side effects, using the
 * same rules as placing an order. Prisma is faked.
 */

const now = new Date('2026-11-23T10:00:00Z');
const dec = (v: string) => new Prisma.Decimal(v);

function build(opts: {
    product?: Record<string, unknown> | null;
    price?: Record<string, unknown> | null;
    sku?: unknown;
} = {}) {
    const product =
        opts.product === undefined
            ? { id: 'p1', name: 'Tee', status: 'PUBLISHED', isActive: true, archivedAt: null, organizationId: null, releaseStart: null, releaseEnd: null }
            : opts.product;
    const price =
        opts.price === undefined
            ? { amount: dec('2499.00'), isFree: false, costOfGoods: null, marketId: 'm-in', market: { id: 'm-in', currency: 'INR' } }
            : opts.price;
    const prisma = {
        drop: { findUnique: jest.fn(async () => product) },
        dropPrice: { findFirst: jest.fn(async () => price) },
        sku: { findFirst: jest.fn(async () => (opts.sku === undefined ? { id: 'sku-1' } : opts.sku)) },
        order: { create: jest.fn() },
        inventoryReservation: { create: jest.fn() },
        $transaction: jest.fn(),
    };
    const repo = new OrderWriteRepository(prisma as never);
    return { repo, prisma, adapter: new OrderLedgerAdapter(repo) };
}

const params = { productId: 'p1', variantId: null, marketId: null, now };

describe('OrderWriteRepository.quote', () => {
    it('IN_STOCK with the market price and currency', async () => {
        const { repo } = build();
        const quote = await repo.quote(params);
        expect(quote).toMatchObject({
            productId: 'p1', marketId: 'm-in', currency: 'INR', availability: 'IN_STOCK', unavailableReason: null,
        });
        expect(quote.unitPrice.toFixed(2)).toBe('2499.00');
    });

    it('SOLD_OUT when no unit is free, and still returns the price', async () => {
        const { repo } = build({ sku: null });
        await expect(repo.quote(params)).resolves.toMatchObject({
            availability: 'SOLD_OUT', unavailableReason: 'SOLD_OUT', currency: 'INR',
        });
    });

    it.each([
        ['not published', { status: 'DRAFT' }, 'NOT_PUBLISHED'],
        ['not open yet', { releaseStart: new Date('2026-12-01T00:00:00Z') }, 'NOT_OPEN_YET'],
        ['closed', { releaseEnd: new Date('2026-11-01T00:00:00Z') }, 'CLOSED'],
    ])('NOT_ON_SALE when %s', async (_label, over, reason) => {
        const { repo, prisma } = build({
            product: { id: 'p1', name: 'Tee', status: 'PUBLISHED', isActive: true, archivedAt: null, organizationId: null, releaseStart: null, releaseEnd: null, ...over },
        });
        await expect(repo.quote(params)).resolves.toMatchObject({ availability: 'NOT_ON_SALE', unavailableReason: reason });
        // no need to probe stock for something that is not on sale
        expect(prisma.sku.findFirst).not.toHaveBeenCalled();
    });

    it('an unknown, switched-off or archived drop is 404 ORDERS_NOT_FOUND', async () => {
        for (const product of [null, { id: 'p1', status: 'PUBLISHED', isActive: false, archivedAt: null }, { id: 'p1', status: 'PUBLISHED', isActive: true, archivedAt: new Date() }]) {
            const { repo } = build({ product });
            await expect(repo.quote(params)).rejects.toMatchObject({ statusCode: 404, code: 'ORDERS_NOT_FOUND' });
        }
    });

    it('no price for the market is 400 ORDERS_NO_PRICE', async () => {
        const { repo } = build({ price: null });
        await expect(repo.quote({ ...params, marketId: 'm-us' })).rejects.toMatchObject({ statusCode: 400, code: 'ORDERS_NO_PRICE' });
    });

    it('asks for the same price row and the same free unit as placing an order', async () => {
        const { repo, prisma } = build();
        await repo.quote({ ...params, variantId: 'v1', marketId: 'm-in' });
        expect(prisma.dropPrice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ dropId: 'p1', variantId: 'v1', marketId: 'm-in', status: 'ACTIVE' }),
        }));
        expect(prisma.sku.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                productId: 'p1', variantId: 'v1', isActive: true, claimedStatus: 'UNCLAIMED', orders: { none: {} },
            }),
        }));
    });

    it('writes nothing', async () => {
        const { repo, prisma } = build();
        await repo.quote(params);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.order.create).not.toHaveBeenCalled();
        expect(prisma.inventoryReservation.create).not.toHaveBeenCalled();
    });
});

describe('OrderLedgerAdapter.quoteSale', () => {
    it('hands payments money as strings', async () => {
        const { adapter } = build();
        await expect(adapter.quoteSale({ productId: 'p1' })).resolves.toEqual({
            productId: 'p1', variantId: null, marketId: 'm-in', currency: 'INR', unitPrice: '2499.00',
            availability: 'IN_STOCK', unavailableReason: null,
        });
    });
});
