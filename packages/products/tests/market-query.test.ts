import { describe, expect, it } from '@jest/globals';
import {
    discoverFeedQuerySchema,
    discoverProductsQuerySchema,
} from '@hitbox/discover';
import { marketplaceFeedQuerySchema, marketplaceListingsQuerySchema } from '@hitbox/marketplace';
import { marketIdQuerySchema } from '../src/dto/product.dto';

/**
 * `?marketId=` is optional everywhere and never a 422: a value that is not a
 * uuid is dropped, so the response falls back to the default market.
 */

const ID = 'b2222222-2222-4222-8222-222222222222';

const schemas = {
    'GET /discover': discoverFeedQuerySchema,
    'GET /discover/products': discoverProductsQuerySchema,
    'GET /marketplace': marketplaceFeedQuerySchema,
    'GET /marketplace/listings': marketplaceListingsQuerySchema,
    'GET /products/:id': marketIdQuerySchema,
};

describe.each(Object.entries(schemas))('%s query', (_route, schema) => {
    it('keeps a valid marketId', () => {
        expect(schema.parse({ marketId: ID }).marketId).toBe(ID);
    });
    it('is optional', () => {
        expect(schema.parse({}).marketId).toBeUndefined();
    });
    it('ignores a value that is not a uuid instead of failing', () => {
        expect(() => schema.parse({ marketId: 'not-a-uuid' })).not.toThrow();
        expect(schema.parse({ marketId: 'not-a-uuid' }).marketId).toBeUndefined();
    });
});
