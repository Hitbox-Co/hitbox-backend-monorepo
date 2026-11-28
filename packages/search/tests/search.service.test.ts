import { describe, expect, it, jest } from '@jest/globals';
import type { IProductDiscovery } from '@hitbox/discover';
import type { IUserSearch } from '../src/domain/interfaces/user-search.interface';
import { searchQuerySchema } from '../src/dto/search.dto';
import { SearchService, normaliseSearchText } from '../src/service/search.service';

const logger = { debug: jest.fn() } as never;

function build() {
    const catalog = {
        findProducts: jest.fn(async () => ({ items: [{ id: 'p1' }], total: 12 })),
        findCreators: jest.fn(async () => ({ items: [{ id: 'a1' }], total: 3 })),
    } as unknown as jest.Mocked<IProductDiscovery>;
    const users = {
        findUsers: jest.fn(async () => ({ items: [{ id: 'u1' }], total: 2 })),
    } as unknown as jest.Mocked<IUserSearch>;
    const service = new SearchService({ catalog, users, logger });
    return { catalog, users, service };
}

const parse = (q: Record<string, unknown>) => searchQuerySchema.parse(q);

describe('SearchService', () => {
    it('type=all queries all three sources with the overview page size', async () => {
        const { service, catalog, users } = build();
        const result = await service.search({ ...parse({ q: 'nova' }), viewerId: 'me' });

        expect(result.type).toBe('all');
        expect(result.products?.total).toBe(12);
        expect(result.artists?.total).toBe(3);
        expect(result.users?.total).toBe(2);
        expect(catalog.findProducts).toHaveBeenCalledWith(
            expect.objectContaining({ search: 'nova', page: 1, limit: 5, viewerId: 'me' }),
        );
        expect(catalog.findCreators).toHaveBeenCalledWith({ search: 'nova', page: 1, limit: 5 });
        expect(users.findUsers).toHaveBeenCalledWith({
            text: 'nova',
            skip: 0,
            take: 5,
            excludeUserId: 'me',
        });
    });

    it('type=all ignores page and caps the limit', async () => {
        const { service, catalog } = build();
        const result = await service.search(parse({ q: 'nova', page: '4', limit: '500' }));

        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
        expect(catalog.findProducts).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
    });

    it('a single type only queries that source and nulls the others', async () => {
        const { service, catalog, users } = build();
        const result = await service.search(parse({ q: 'mia', type: 'users', page: '3', limit: '10' }));

        expect(result.products).toBeNull();
        expect(result.artists).toBeNull();
        expect(result.users?.total).toBe(2);
        expect(catalog.findProducts).not.toHaveBeenCalled();
        expect(catalog.findCreators).not.toHaveBeenCalled();
        expect(users.findUsers).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'mia', skip: 20, take: 10 }),
        );
        expect(result.page).toBe(3);
    });

    it('a single type defaults to 20 and caps at 50', async () => {
        const { service } = build();
        expect((await service.search(parse({ q: 'x', type: 'products' }))).limit).toBe(20);
        expect((await service.search(parse({ q: 'x', type: 'products', limit: '999' }))).limit).toBe(50);
    });

    it('drops a leading @ so a handle can be typed naturally', async () => {
        const { service, users } = build();
        const result = await service.search(parse({ q: '@mia.figures', type: 'users' }));

        expect(result.query).toBe('mia.figures');
        expect(users.findUsers).toHaveBeenCalledWith(expect.objectContaining({ text: 'mia.figures' }));
    });

    it('a lone @ returns empty sections without touching any source', async () => {
        const { service, catalog, users } = build();
        const result = await service.search(parse({ q: '@' }));

        expect(result.products).toEqual({ items: [], total: 0 });
        expect(result.artists).toEqual({ items: [], total: 0 });
        expect(result.users).toEqual({ items: [], total: 0 });
        expect(catalog.findProducts).not.toHaveBeenCalled();
        expect(users.findUsers).not.toHaveBeenCalled();
    });

    it('passes no excludeUserId and no viewer for a guest', async () => {
        const { service, catalog, users } = build();
        await service.search(parse({ q: 'nova' }));

        expect(users.findUsers).toHaveBeenCalledWith(expect.objectContaining({ excludeUserId: undefined }));
        expect(catalog.findProducts).toHaveBeenCalledWith(expect.objectContaining({ viewerId: undefined }));
    });
});

describe('searchQuerySchema', () => {
    it('requires q', () => {
        expect(searchQuerySchema.safeParse({}).success).toBe(false);
        expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    });

    it('rejects q over 100 characters and an unknown type', () => {
        expect(searchQuerySchema.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
        expect(searchQuerySchema.safeParse({ q: 'a', type: 'orders' }).success).toBe(false);
    });

    it('ignores a bad marketId instead of failing', () => {
        const parsed = searchQuerySchema.parse({ q: 'a', marketId: 'not-a-uuid' });
        expect(parsed.marketId).toBeUndefined();
    });
});

describe('normaliseSearchText', () => {
    it('trims and strips leading @', () => {
        expect(normaliseSearchText('  @@Mia ')).toBe('Mia');
    });
});
