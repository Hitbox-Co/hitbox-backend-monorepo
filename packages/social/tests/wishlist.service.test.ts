import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { WishlistService } from '../src/service/wishlist.service';

/** docs/mobile-app/wishlist-api.md */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const card = (over: Record<string, unknown> = {}) => ({
    id: 'p1', name: 'Lucky in Pink', isViewable: true, isPurchasable: true, unavailableReason: null,
    status: 'ACTIVE', variants: [{ id: 'v1', label: 'Pink', isActive: true }], ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
    id: 'w1', userId: 'u1', productId: 'p1', variantId: null, notifyOnAvailable: false, note: null,
    createdAt: new Date('2026-11-18T10:00:00Z'), publicCode: null, ...over,
});

function build(opts: { cards?: unknown[]; existing?: unknown; createError?: unknown } = {}) {
    const wishlist = {
        list: jest.fn(async () => ({ items: [row()], total: 1 })),
        findOne: jest.fn(async () => opts.existing ?? null),
        findById: jest.fn(async () => row()),
        create: jest.fn(async (input: Record<string, unknown>) => {
            if (opts.createError) throw opts.createError;
            return row(input);
        }),
        update: jest.fn(async (_id: string, data: Record<string, unknown>) => row(data)),
        deleteById: jest.fn(async () => 1),
        deleteByProduct: jest.fn(async () => 2),
    };
    const catalog = { findCards: jest.fn(async () => opts.cards ?? [card()]) };
    const service = new WishlistService({ wishlist: wishlist as never, catalog: catalog as never, logger: silentLogger });
    return { service, wishlist };
}

describe('WishlistService.add', () => {
    it('creates a new row (201)', async () => {
        const { service, wishlist } = build();
        const { item, created } = await service.add('u1', { productId: 'p1', notifyOnAvailable: true });
        expect(created).toBe(true);
        expect(wishlist.create).toHaveBeenCalledWith({ userId: 'u1', productId: 'p1', variantId: null, notifyOnAvailable: true, note: null });
        expect(item).toMatchObject({ productId: 'p1', variant: null, notifyOnAvailable: true, product: { id: 'p1' } });
    });

    it('is idempotent: an existing row comes back with created=false', async () => {
        const { service, wishlist } = build({ existing: row() });
        const { created } = await service.add('u1', { productId: 'p1' });
        expect(created).toBe(false);
        expect(wishlist.create).not.toHaveBeenCalled();
        expect(wishlist.update).not.toHaveBeenCalled();
    });

    it('re-adding with a note updates the existing row', async () => {
        const { service, wishlist } = build({ existing: row() });
        await service.add('u1', { productId: 'p1', note: 'birthday' });
        expect(wishlist.update).toHaveBeenCalledWith('w1', { note: 'birthday' });
    });

    it('a racing double tap (unique violation) returns the winner row', async () => {
        const race = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        const { service, wishlist } = build({ createError: race });
        wishlist.findOne.mockResolvedValueOnce(null as never).mockResolvedValueOnce(row() as never);
        await expect(service.add('u1', { productId: 'p1' })).resolves.toMatchObject({ created: false });
    });

    it('an unknown or non-public drop is a 404', async () => {
        await expect(build({ cards: [] }).service.add('u1', { productId: 'p1' })).rejects.toMatchObject({ statusCode: 404, code: 'SOCIAL_PRODUCT_NOT_FOUND' });
        await expect(build({ cards: [card({ isViewable: false })] }).service.add('u1', { productId: 'p1' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it("a variant from another drop is a 404", async () => {
        await expect(build().service.add('u1', { productId: 'p1', variantId: 'other' }))
            .rejects.toMatchObject({ code: 'SOCIAL_VARIANT_NOT_FOUND' });
    });

    it('an ended (not purchasable) drop can still be wishlisted', async () => {
        const { created } = await build({ cards: [card({ status: 'ENDED', isPurchasable: false })] }).service.add('u1', { productId: 'p1' });
        expect(created).toBe(true);
    });
});

describe('WishlistService removal', () => {
    it('remove by id 404s when the row is not the caller’s', async () => {
        const { service, wishlist } = build();
        wishlist.deleteById.mockResolvedValueOnce(0 as never);
        await expect(service.remove('u1', 'w9')).rejects.toMatchObject({ code: 'SOCIAL_WISHLIST_ITEM_NOT_FOUND' });
    });

    it('remove by product is idempotent and reports the count', async () => {
        const { service, wishlist } = build();
        await expect(service.removeByProduct('u1', 'p1')).resolves.toEqual({ removed: 2 });
        expect(wishlist.deleteByProduct).toHaveBeenCalledWith('u1', 'p1', undefined);
    });
});
