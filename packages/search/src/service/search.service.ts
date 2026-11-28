import type { Logger } from 'pino';
import type { IProductDiscovery } from '@hitbox/discover';
import {
    SEARCH_ALL_DEFAULT_LIMIT,
    SEARCH_ALL_MAX_LIMIT,
    SEARCH_TYPE_DEFAULT_LIMIT,
    SEARCH_TYPE_MAX_LIMIT,
} from '../constants/search.constant';
import type { IUserSearch } from '../domain/interfaces/user-search.interface';
import type { SearchQueryDto, SearchResultDto } from '../dto/search.dto';

interface SearchServiceDeps {
    /** Products and artists — discover's port, implemented by products. */
    catalog: IProductDiscovery;
    users: IUserSearch;
    logger: Logger;
}

export type SearchRequest = SearchQueryDto & {
    /** The signed-in account: fills `isWishlisted` and is left out of the people results. */
    viewerId?: string | undefined;
};

/** "@mia" and "mia" find the same person. */
export function normaliseSearchText(raw: string): string {
    return raw.trim().replace(/^@+/, '').trim();
}

export class SearchService {
    constructor(private readonly deps: SearchServiceDeps) { }

    /**
     * One search box for the whole app. `type=all` runs the three lookups in
     * parallel and returns the first few of each; a single `type` returns just
     * that section, paginated, for a "See all" tab.
     */
    async search(request: SearchRequest): Promise<SearchResultDto> {
        const text = normaliseSearchText(request.q);
        const { type, viewerId, marketId } = request;
        const all = type === 'all';

        const cap = all ? SEARCH_ALL_MAX_LIMIT : SEARCH_TYPE_MAX_LIMIT;
        const fallback = all ? SEARCH_ALL_DEFAULT_LIMIT : SEARCH_TYPE_DEFAULT_LIMIT;
        const limit = Math.min(request.limit ?? fallback, cap);
        const page = all ? 1 : request.page;
        const skip = (page - 1) * limit;

        // An "@" on its own leaves nothing to search for.
        if (text.length === 0) {
            return {
                query: text,
                type,
                page,
                limit,
                products: all || type === 'products' ? { items: [], total: 0 } : null,
                artists: all || type === 'artists' ? { items: [], total: 0 } : null,
                users: all || type === 'users' ? { items: [], total: 0 } : null,
            };
        }

        const [products, artists, users] = await Promise.all([
            all || type === 'products'
                ? this.deps.catalog.findProducts({ search: text, page, limit, viewerId, marketId })
                : null,
            all || type === 'artists'
                ? this.deps.catalog.findCreators({ search: text, page, limit })
                : null,
            all || type === 'users'
                ? this.deps.users.findUsers({ text, skip, take: limit, excludeUserId: viewerId })
                : null,
        ]);

        this.deps.logger.debug(
            {
                type,
                products: products?.total,
                artists: artists?.total,
                users: users?.total,
            },
            'search.executed',
        );

        return { query: text, type, page, limit, products, artists, users };
    }
}
