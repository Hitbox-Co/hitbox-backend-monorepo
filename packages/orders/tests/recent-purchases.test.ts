import { Prisma } from '@hitbox/database';
import { recentPurchasesQuerySchema } from '../src/dto/buyer-order.dto';
import { BuyerOrderService } from '../src/service/buyer-order.service';

/**
 * "Did the buyer purchase anything in the last 24 hours?" The repository is
 * faked; the window and the status filter are asserted on what the service
 * asks it for, and the queries run against a real database separately.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const dec = (v: string) => new Prisma.Decimal(v);
const NOW = new Date(Date.UTC(2026, 10, 28, 12, 0, 0));
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const dropOf = (id: string, name: string) => ({
    id, name, groupCode: `G-${id}`,
    artist: { name: 'Kaze' },
    dropImages: [{ asset: { storageRef: `drop-images/${id}.png` } }],
});

const row = (id: string, dropId: string, paidHoursAgo: number, over: Record<string, unknown> = {}) => ({
    id, publicCode: `odr${id}`, status: 'PAID', paidAt: hoursAgo(paidHoursAgo), quantity: 1,
    amount: dec('480.00'), currency: 'USD',
    drop: dropOf(dropId, `Drop ${dropId}`),
    variant: null,
    ...over,
});

function build(rows: unknown[] = []) {
    const orders = { findPaidSince: jest.fn(async () => rows) };
    const service = new BuyerOrderService({
        orders: orders as never, writes: {} as never,
        mediaUrls: { publicUrl: (ref: string) => `https://cdn.example/${ref}` },
        eventBus: {} as never, logger: silentLogger, returnWindowDays: 10,
    });
    return { service, orders };
}

const query = (q: Record<string, unknown> = {}) => recentPurchasesQuerySchema.parse(q);

describe('BuyerOrderService.recentPurchases', () => {
    it('nothing bought: hasPurchased false and empty lists', async () => {
        const { service } = build([]);
        const result = await service.recentPurchases('buyer-1', query(), NOW);

        expect(result).toEqual({
            hasPurchased: false,
            windowHours: 24,
            since: hoursAgo(24).toISOString(),
            count: 0,
            purchases: [],
            drops: [],
        });
    });

    it('asks only for this buyer, the last 24 hours, and orders that really are bought', async () => {
        const { service, orders } = build([]);
        await service.recentPurchases('buyer-1', query(), NOW);

        expect(orders.findPaidSince).toHaveBeenCalledWith({
            buyerId: 'buyer-1',
            since: hoursAgo(24),
            statuses: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'],
            take: 100,
        });
    });

    it('one purchase: returns the order and its drop', async () => {
        const { service } = build([row('o1', 'd1', 3, { variant: { label: 'M / Black' } })]);
        const result = await service.recentPurchases('buyer-1', query(), NOW);

        expect(result.hasPurchased).toBe(true);
        expect(result.count).toBe(1);
        expect(result.purchases[0]).toEqual({
            orderId: 'o1',
            reference: 'odro1',
            status: 'PAID',
            statusLabel: 'Order confirmed',
            paidAt: hoursAgo(3).toISOString(),
            drop: {
                id: 'd1', name: 'Drop d1', code: 'G-d1',
                imageUrl: 'https://cdn.example/drop-images/d1.png', artistName: 'Kaze',
            },
            variantLabel: 'M / Black',
            quantity: 1,
            amount: '480.00',
            currency: 'USD',
        });
        expect(result.drops).toEqual([
            {
                id: 'd1', name: 'Drop d1', code: 'G-d1',
                imageUrl: 'https://cdn.example/drop-images/d1.png', artistName: 'Kaze',
                purchaseCount: 1, lastPurchasedAt: hoursAgo(3).toISOString(),
            },
        ]);
    });

    it('several drops: one entry per drop, most recently bought first', async () => {
        // The repository returns newest payment first.
        const { service } = build([row('o3', 'd2', 1), row('o2', 'd1', 5), row('o1', 'd2', 20)]);
        const result = await service.recentPurchases('buyer-1', query(), NOW);

        expect(result.count).toBe(3);
        expect(result.purchases.map((p) => p.orderId)).toEqual(['o3', 'o2', 'o1']);
        expect(result.drops.map((d) => d.id)).toEqual(['d2', 'd1']);
        expect(result.drops[0]).toMatchObject({ id: 'd2', purchaseCount: 2, lastPurchasedAt: hoursAgo(1).toISOString() });
        expect(result.drops[1]).toMatchObject({ id: 'd1', purchaseCount: 1 });
    });

    it('hours widens the window', async () => {
        const { service, orders } = build([]);
        const result = await service.recentPurchases('buyer-1', query({ hours: '72' }), NOW);

        expect(result.windowHours).toBe(72);
        expect(result.since).toBe(hoursAgo(72).toISOString());
        expect(orders.findPaidSince).toHaveBeenCalledWith(expect.objectContaining({ since: hoursAgo(72) }));
    });

    it('a null image comes back as null when the drop has none', async () => {
        const noImage = row('o1', 'd1', 2, { drop: { ...dropOf('d1', 'Drop d1'), dropImages: [] } });
        const { service } = build([noImage]);
        const result = await service.recentPurchases('buyer-1', query(), NOW);
        expect(result.drops[0]?.imageUrl).toBeNull();
    });

    it('skips a row with no paidAt rather than failing', async () => {
        const { service } = build([row('o1', 'd1', 2, { paidAt: null })]);
        const result = await service.recentPurchases('buyer-1', query(), NOW);
        expect(result.hasPurchased).toBe(false);
    });
});

describe('recentPurchasesQuerySchema', () => {
    it('defaults to 24 hours', () => {
        expect(query().hours).toBe(24);
    });

    it('accepts 1 to 168 and rejects anything else', () => {
        expect(recentPurchasesQuerySchema.safeParse({ hours: '1' }).success).toBe(true);
        expect(recentPurchasesQuerySchema.safeParse({ hours: '168' }).success).toBe(true);
        expect(recentPurchasesQuerySchema.safeParse({ hours: '0' }).success).toBe(false);
        expect(recentPurchasesQuerySchema.safeParse({ hours: '169' }).success).toBe(false);
        expect(recentPurchasesQuerySchema.safeParse({ hours: 'abc' }).success).toBe(false);
    });
});
