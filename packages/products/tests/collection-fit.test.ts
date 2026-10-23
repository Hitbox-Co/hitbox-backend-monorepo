import { AppError } from '@hitbox/shared';
import { PRODUCTS_ERROR_CODES } from '../src/constants/products.constant';
import { ProductService } from '../src/service/product.service';

/**
 * A drop may only be filed under a live collection of its own artist —
 * docs/artist-collection/README.md §3. Exercised through `update`, the path
 * with the fewest collaborators; `create` runs the same check.
 */

const KAZE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LUMEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KAZE_SET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LUMEN_SET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_SET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const collections: Record<string, { artistId: string; archivedAt: Date | null }> = {
    [KAZE_SET]: { artistId: KAZE, archivedAt: null },
    [LUMEN_SET]: { artistId: LUMEN, archivedAt: null },
    [OLD_SET]: { artistId: KAZE, archivedAt: new Date('2026-10-01T00:00:00Z') },
};

function build(current: { artistId: string | null; collectionId: string | null }) {
    const products = {
        findById: jest.fn(async () => ({ id: 'p1', dropType: null, ...current })),
        findCollectionOwner: jest.fn(async (id: string) => collections[id] ?? null),
        update: jest.fn(async () => ({})),
    };
    const service = new ProductService({
        products,
        eventBus: { publish: jest.fn(async () => undefined), subscribe: jest.fn() },
    } as never);
    jest.spyOn(service as unknown as { toResponse: () => unknown }, 'toResponse').mockReturnValue({});
    return { service, products };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
    }
    return 'NO_ERROR';
}

describe('filing a drop under a collection', () => {
    it('accepts a live collection of the drop’s own artist', async () => {
        const { service, products } = build({ artistId: KAZE, collectionId: null });
        await service.update('p1', { collectionId: KAZE_SET } as never);
        expect(products.update).toHaveBeenCalled();
    });

    it('refuses another artist’s collection', async () => {
        const { service, products } = build({ artistId: KAZE, collectionId: null });
        expect(await codeOf(service.update('p1', { collectionId: LUMEN_SET } as never)))
            .toBe(PRODUCTS_ERROR_CODES.COLLECTION_ARTIST_MISMATCH);
        expect(products.update).not.toHaveBeenCalled();
    });

    it('refuses changing the artist away from the collection the drop is in', async () => {
        const { service } = build({ artistId: KAZE, collectionId: KAZE_SET });
        expect(await codeOf(service.update('p1', { artistId: LUMEN } as never)))
            .toBe(PRODUCTS_ERROR_CODES.COLLECTION_ARTIST_MISMATCH);
    });

    it('accepts moving artist and collection together', async () => {
        const { service, products } = build({ artistId: KAZE, collectionId: KAZE_SET });
        await service.update('p1', { artistId: LUMEN, collectionId: LUMEN_SET } as never);
        expect(products.update).toHaveBeenCalled();
    });

    it('refuses a drop with no artist', async () => {
        const { service } = build({ artistId: null, collectionId: null });
        expect(await codeOf(service.update('p1', { collectionId: KAZE_SET } as never)))
            .toBe(PRODUCTS_ERROR_CODES.COLLECTION_ARTIST_MISMATCH);
    });

    it('refuses an archived collection and an unknown one', async () => {
        const { service } = build({ artistId: KAZE, collectionId: null });
        expect(await codeOf(service.update('p1', { collectionId: OLD_SET } as never)))
            .toBe(PRODUCTS_ERROR_CODES.COLLECTION_ARCHIVED);
        expect(await codeOf(service.update('p1', { collectionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } as never)))
            .toBe(PRODUCTS_ERROR_CODES.COLLECTION_NOT_FOUND);
    });

    it('lets a drop leave its collection, and doesn’t re-check unrelated edits', async () => {
        const { service, products } = build({ artistId: KAZE, collectionId: OLD_SET });
        await service.update('p1', { collectionId: null } as never);
        await service.update('p1', { name: 'Renamed' } as never);
        expect(products.findCollectionOwner).not.toHaveBeenCalled();
        expect(products.update).toHaveBeenCalledTimes(2);
    });
});
