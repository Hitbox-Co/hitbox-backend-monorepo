import { describe, expect, it, jest } from '@jest/globals';
import { ProductService } from '../src/service/product.service';

/** GET /products/:id and /products/code/:groupCode never show an unreleased or withdrawn drop. */

function build(row: Record<string, unknown> | null) {
    const products = {
        findById: jest.fn(async () => row),
        findByGroupCode: jest.fn(async () => row),
    };
    const service = new ProductService({ products } as never);
    // The visibility rule is under test, not the response mapping.
    (service as unknown as { toResponse: (p: unknown) => unknown }).toResponse = (p) => p;
    return service;
}

const drop = (over: Record<string, unknown> = {}) => ({
    id: 'd1', groupCode: 'G1', status: 'ACTIVE', isActive: true, archivedAt: null, ...over,
});

describe('public product detail visibility', () => {
    it.each(['PUBLISHED', 'ACTIVE', 'ENDED'])('shows a %s drop', async (status) => {
        await expect(build(drop({ status })).getById('d1')).resolves.toMatchObject({ id: 'd1' });
        await expect(build(drop({ status })).getByGroupCode('G1')).resolves.toMatchObject({ id: 'd1' });
    });

    it.each(['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'])(
        'a %s drop is a 404',
        async (status) => {
            await expect(build(drop({ status })).getById('d1')).rejects.toMatchObject({ statusCode: 404 });
            await expect(build(drop({ status })).getByGroupCode('G1')).rejects.toMatchObject({ statusCode: 404 });
        },
    );

    it('a deactivated drop is a 404', async () => {
        await expect(build(drop({ isActive: false })).getById('d1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('an archived drop is a 404, including one read back from the cache as a string date', async () => {
        await expect(build(drop({ archivedAt: new Date() })).getById('d1')).rejects.toMatchObject({ statusCode: 404 });
        await expect(build(drop({ archivedAt: '2026-11-01T00:00:00.000Z' })).getById('d1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('a missing drop is a 404', async () => {
        await expect(build(null).getById('nope')).rejects.toMatchObject({ statusCode: 404 });
    });
});
