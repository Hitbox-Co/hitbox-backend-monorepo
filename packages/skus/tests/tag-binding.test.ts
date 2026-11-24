import { bindTagSchema, bulkBindTagsSchema, mintSkusSchema } from '../src/dto/sku.dto';

/**
 * Chip UIDs are the platform's anti-counterfeiting material. These properties
 * live in the schemas, so they are pinned here:
 *
 *   - a UID is stored in ONE canonical form, or `Sku.tagId`'s unique index
 *     stops catching clones;
 *   - a manifest cannot be half-specified, because a silently untagged tail of
 *     a batch is indistinguishable from a correctly tagged one;
 *   - a chip cannot be added without its keys: a bare UID can never be verified.
 */

const K0 = '000102030405060708090A0B0C0D0E0F';
const K1 = '101112131415161718191A1B1C1D1E1F';
const K2 = '202122232425262728292A2B2C2D2E2F';
const keys = { key0: K0, key1: K1, key2: K2 };
const UID = (n: number) => `04A39B2C5D6E${String(80 + n).padStart(2, '0')}`;

describe('tag normalisation', () => {
    it('collapses every separator spelling to one stored form', () => {
        const parsed = bulkBindTagsSchema.parse({
            bindings: [
                { serialNumber: 1, uid: '04:A3:9B:2C:5D:6E:80', ...keys },
                { serialNumber: 2, uid: '04-a3-9b-2c-5d-6e-81', ...keys },
                { serialNumber: 3, uid: '04 a3 9b 2c 5d 6e 82', ...keys },
            ],
        });
        expect(parsed.bindings.map((b) => b.uid)).toEqual(['04A39B2C5D6E80', '04A39B2C5D6E81', '04A39B2C5D6E82']);
    });

    it('rejects a non-hex UID', () => {
        expect(bindTagSchema.safeParse({ chip: { uid: 'ZZZZZZZZZZZZZZ', ...keys } }).success).toBe(false);
    });

    it('catches the same physical chip sent twice under different spellings', () => {
        // Normalisation runs before the duplicate check, so `04:A3…` and
        // `04a3…` are caught as one chip rather than sailing through as two.
        const result = bulkBindTagsSchema.safeParse({
            bindings: [
                { serialNumber: 1, uid: '04:A3:9B:2C:5D:6E:80', ...keys },
                { serialNumber: 2, uid: '04a39b2c5d6e80', ...keys },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('catches the same unit appearing twice', () => {
        const result = bulkBindTagsSchema.safeParse({
            bindings: [
                { serialNumber: 7, uid: UID(0), ...keys },
                { serialNumber: 7, uid: UID(1), ...keys },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('requires exactly one way of naming the unit', () => {
        const both = bulkBindTagsSchema.safeParse({
            bindings: [{ serialNumber: 1, skuCode: 'X-000001', uid: UID(0), ...keys }],
        });
        const neither = bulkBindTagsSchema.safeParse({ bindings: [{ uid: UID(0), ...keys }] });
        expect(both.success).toBe(false);
        expect(neither.success).toBe(false);
    });

    it('accepts a serial number arriving as a string, as a CSV import gives it', () => {
        const parsed = bulkBindTagsSchema.parse({ bindings: [{ serialNumber: '14', uid: UID(0), ...keys }] });
        expect(parsed.bindings[0]!.serialNumber).toBe(14);
    });

    it('does not replace an existing chip unless asked', () => {
        expect(bindTagSchema.parse({ chip: { uid: UID(0), ...keys } }).replace).toBe(false);
    });
});

describe('a chip cannot be added without its keys', () => {
    it('bind: a bare UID, in any of the old shapes, is refused with a clear reason', () => {
        for (const body of [
            { tagId: UID(0) },
            { chip: { uid: UID(0) } },
            { chip: { uid: UID(0), key0: K0 } },
        ]) {
            expect(bindTagSchema.safeParse(body).success).toBe(false);
        }
        const refused = bindTagSchema.safeParse({ tagId: UID(0) });
        expect(JSON.stringify(refused)).toContain('no longer accepted');
    });

    it('bulk bind: a binding with a bare tagId or a uid without keys is refused', () => {
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, tagId: UID(0) }] }).success).toBe(false);
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, uid: UID(0) }] }).success).toBe(false);
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, uid: UID(0), ...keys }] }).success).toBe(true);
    });

    it('mint: bare tagIds are refused, chips need all three keys', () => {
        expect(mintSkusSchema.safeParse({ count: 1, tagIds: [UID(0)] }).success).toBe(false);
        expect(mintSkusSchema.safeParse({ count: 1, chips: [{ uid: UID(0) }] }).success).toBe(false);
        expect(mintSkusSchema.safeParse({ count: 1, chips: [{ uid: UID(0), ...keys }] }).success).toBe(true);
    });
});

describe('mint: chips', () => {
    it('refuses a chip list shorter than the batch', () => {
        // The failure this prevents: minting 500 with 3 chips and silently
        // leaving 497 units without one.
        const result = mintSkusSchema.safeParse({
            count: 500,
            chips: [0, 1, 2].map((n) => ({ uid: UID(n), ...keys })),
        });
        expect(result.success).toBe(false);
    });

    it('accepts a chip list exactly as long as the batch', () => {
        expect(
            mintSkusSchema.safeParse({ count: 2, chips: [0, 1].map((n) => ({ uid: UID(n), ...keys })) }).success,
        ).toBe(true);
    });

    it('accepts a mint with no chips at all — the normal path for a big edition', () => {
        expect(mintSkusSchema.safeParse({ count: 500 }).success).toBe(true);
    });

    it('caps a single mint batch', () => {
        expect(mintSkusSchema.safeParse({ count: 10_000 }).success).toBe(false);
    });
});
