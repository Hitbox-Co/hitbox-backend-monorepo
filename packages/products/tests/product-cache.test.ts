import { Prisma } from '@hitbox/database';
import { deserialise, serialise } from '../src/cache/product-cache';

/**
 * Regression test for a 500 that only happened on a warm cache:
 *
 *     TypeError: product.releaseStart?.toISOString is not a function
 *
 * A row read from Postgres holds `Date` and `Prisma.Decimal`. The same row read
 * back from Redis through `JSON.parse` held plain strings — a different shape
 * behind the same TypeScript type, because the cast at the parse boundary
 * asserts something nobody checked. Every product read was affected once Redis
 * was configured; the detail endpoint was simply the first one called.
 */

describe('cache codec', () => {
    it('brings a Date back as a Date', () => {
        const value = { releaseStart: new Date('2026-10-01T09:00:00.000Z') };
        const back = deserialise<typeof value>(serialise(value));

        expect(back.releaseStart).toBeInstanceOf(Date);
        expect(back.releaseStart.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    });

    it('brings a Decimal back as a Decimal, with the exact value', () => {
        const value = { amount: new Prisma.Decimal('1999.99') };
        const back = deserialise<typeof value>(serialise(value));

        expect(Prisma.Decimal.isDecimal(back.amount)).toBe(true);
        expect(back.amount.toString()).toBe('1999.99');
    });

    it('survives the shape a product row actually has', () => {
        // Nested relations and nullable dates, which is where the original bug
        // hid: `releaseStart` is nullable, so it only threw for drops that had
        // one set.
        const row = {
            id: 'p1',
            name: 'Neon Drift',
            releaseStart: new Date('2026-10-01T09:00:00.000Z'),
            releaseEnd: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            dropPrices: [
                { amount: new Prisma.Decimal('1999.00'), isFree: false, market: { code: 'IN' } },
            ],
            dropImages: [{ asset: { storageRef: 'drop-images/a.jpg' } }],
        };
        const back = deserialise<typeof row>(serialise(row));

        expect(back.releaseStart.toISOString()).toBe('2026-10-01T09:00:00.000Z');
        expect(back.releaseEnd).toBeNull();
        expect(back.createdAt).toBeInstanceOf(Date);
        // `toFixed(2)`, not `toString()` — Decimal normalises trailing zeros,
        // so `new Decimal('1999.00').toString()` is `'1999'`. That is faithful
        // round-tripping, not data loss, but it is also why the API formats
        // money with toFixed(2) rather than toString().
        expect(back.dropPrices[0]!.amount.toFixed(2)).toBe('1999.00');
        expect(back.dropPrices[0]!.amount.equals(new Prisma.Decimal('1999'))).toBe(true);
        expect(back.dropImages[0]!.asset.storageRef).toBe('drop-images/a.jpg');
        expect(back.name).toBe('Neon Drift');
    });

    it('leaves a string that merely looks like a timestamp alone', () => {
        // Why values are tagged on write instead of sniffed on read: a reviver
        // that converted anything ISO-shaped would corrupt legitimate text.
        const value = { description: '2026-10-01T09:00:00.000Z', altText: '2026-10-01' };
        const back = deserialise<typeof value>(serialise(value));

        expect(typeof back.description).toBe('string');
        expect(back.description).toBe('2026-10-01T09:00:00.000Z');
        expect(typeof back.altText).toBe('string');
    });

    it('round-trips arrays, nulls and primitives unchanged', () => {
        const value = {
            images: ['a', 'b'],
            variants: [],
            isActive: true,
            totalSupply: 500,
            description: null,
        };
        expect(deserialise(serialise(value))).toEqual(value);
    });
});
