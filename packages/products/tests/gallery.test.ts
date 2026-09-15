import { normaliseGallery } from '../src/service/product.service';

/**
 * The gallery has two invariants the schema cannot express — contiguous
 * positions and exactly one primary — so they are enforced on every write.
 * A drag-and-drop UI violates both constantly and neither fails loudly; they
 * just render wrong.
 */

const img = (assetId: string, extra: Partial<{ position: number; isPrimary: boolean }> = {}) => ({
    assetId,
    altText: null,
    ...extra,
});

describe('normaliseGallery', () => {
    it('numbers positions 0..n-1 regardless of what arrived', () => {
        const result = normaliseGallery(
            [img('a', { position: 11 }), img('b', { position: 5 }), img('c', { position: 5 })],
            {},
        );
        expect(result.map((r) => [r.assetId, r.position])).toEqual([
            ['b', 0],
            ['c', 1],
            ['a', 2],
        ]);
    });

    it('keeps arrival order when no positions are given', () => {
        const result = normaliseGallery([img('a'), img('b'), img('c')], {});
        expect(result.map((r) => r.assetId)).toEqual(['a', 'b', 'c']);
    });

    it('promotes the first image when nothing claims primary', () => {
        // A gallery with no primary renders with no image on every listing
        // surface, so "none claimed" cannot stay "none".
        const result = normaliseGallery([img('a'), img('b')], {});
        expect(result.filter((r) => r.isPrimary).map((r) => r.assetId)).toEqual(['a']);
    });

    it('honours an explicit primary wherever it sits', () => {
        const result = normaliseGallery([img('a'), img('b', { isPrimary: true })], {});
        expect(result.filter((r) => r.isPrimary).map((r) => r.assetId)).toEqual(['b']);
    });

    it('demotes a second claimant rather than erroring', () => {
        const result = normaliseGallery(
            [img('a', { isPrimary: true }), img('b', { isPrimary: true })],
            {},
        );
        expect(result.filter((r) => r.isPrimary)).toHaveLength(1);
    });

    it('never yields two primaries or a gap, for any input', () => {
        const result = normaliseGallery(
            [
                img('a', { position: 3, isPrimary: true }),
                img('b'),
                img('c', { position: 0, isPrimary: true }),
                img('d', { position: 3 }),
            ],
            { totalWas: 2 },
        );
        expect(result.filter((r) => r.isPrimary)).toHaveLength(1);
        expect(result.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    });

    it('appends new entries after an existing gallery', () => {
        // totalWas biases un-positioned additions to the end instead of
        // interleaving them with images already on the product.
        const result = normaliseGallery(
            [img('old', { position: 0 }), img('new')],
            { totalWas: 1 },
        );
        expect(result.map((r) => r.assetId)).toEqual(['old', 'new']);
    });

    it('handles an empty gallery', () => {
        expect(normaliseGallery([], {})).toEqual([]);
    });
});
