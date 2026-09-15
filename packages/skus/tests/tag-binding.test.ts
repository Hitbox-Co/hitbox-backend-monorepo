import { bindTagSchema, bulkBindTagsSchema, mintSkusSchema } from '../src/dto/sku.dto';

/**
 * Tag UIDs are the platform's anti-counterfeiting material. Two properties are
 * load-bearing and both live in the schema, so both are pinned here:
 *
 *   - a tag is stored in ONE canonical form, or `Sku.tagId`'s unique index
 *     stops catching clones;
 *   - a manifest cannot be half-specified, because a silently untagged tail of
 *     a batch is indistinguishable from a correctly tagged one.
 */

describe('tag normalisation', () => {
    it('collapses every separator spelling to one stored form', () => {
        const parsed = bulkBindTagsSchema.parse({
            bindings: [
                { serialNumber: 1, tagId: '04:A3:9B:2C:5D:6E:80' },
                { serialNumber: 2, tagId: '04-a3-9b-2c-5d-6e-81' },
                { serialNumber: 3, tagId: '04 a3 9b 2c 5d 6e 82' },
            ],
        });
        expect(parsed.bindings.map((b) => b.tagId)).toEqual([
            '04A39B2C5D6E80',
            '04A39B2C5D6E81',
            '04A39B2C5D6E82',
        ]);
    });

    it('rejects a non-hex tag', () => {
        expect(bindTagSchema.safeParse({ tagId: 'ZZZZZZZZ' }).success).toBe(false);
    });

    it('catches the same physical tag sent twice under different spellings', () => {
        // Normalisation runs before the duplicate check, so `04:A3…` and
        // `04a3…` are caught as one tag rather than sailing through as two.
        const result = bulkBindTagsSchema.safeParse({
            bindings: [
                { serialNumber: 1, tagId: '04:A3:9B:2C:5D:6E:80' },
                { serialNumber: 2, tagId: '04a39b2c5d6e80' },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('catches the same unit appearing twice', () => {
        const result = bulkBindTagsSchema.safeParse({
            bindings: [
                { serialNumber: 7, tagId: '04A39B2C5D6E80' },
                { serialNumber: 7, tagId: '04A39B2C5D6E81' },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('requires exactly one way of naming the unit', () => {
        const both = bulkBindTagsSchema.safeParse({
            bindings: [{ serialNumber: 1, skuCode: 'X-000001', tagId: '04A39B2C5D6E80' }],
        });
        const neither = bulkBindTagsSchema.safeParse({
            bindings: [{ tagId: '04A39B2C5D6E80' }],
        });
        expect(both.success).toBe(false);
        expect(neither.success).toBe(false);
    });

    it('accepts a serial number arriving as a string, as a CSV import gives it', () => {
        const parsed = bulkBindTagsSchema.parse({
            bindings: [{ serialNumber: '14', tagId: '04A39B2C5D6E80' }],
        });
        expect(parsed.bindings[0]!.serialNumber).toBe(14);
    });

    it('does not replace an existing tag unless asked', () => {
        expect(bindTagSchema.parse({ tagId: '04A39B2C5D6E80' }).replace).toBe(false);
    });
});

describe('mint — tagIds', () => {
    it('refuses a tag list shorter than the batch', () => {
        // The failure this prevents: minting 500 with 3 tags and silently
        // leaving 497 units untagged.
        const result = mintSkusSchema.safeParse({
            count: 500,
            tagIds: ['04A39B2C5D6E80', '04A39B2C5D6E81', '04A39B2C5D6E82'],
        });
        expect(result.success).toBe(false);
    });

    it('accepts a tag list exactly as long as the batch', () => {
        expect(
            mintSkusSchema.safeParse({
                count: 2,
                tagIds: ['04A39B2C5D6E80', '04A39B2C5D6E81'],
            }).success,
        ).toBe(true);
    });

    it('accepts a mint with no tags at all — the normal path for a big edition', () => {
        expect(mintSkusSchema.safeParse({ count: 500 }).success).toBe(true);
    });

    it('caps a single mint batch', () => {
        expect(mintSkusSchema.safeParse({ count: 10_000 }).success).toBe(false);
    });
});
