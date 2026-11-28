/**
 * @hitbox/search
 *
 * The one search box of the buyer app: products, artists and collectors in a
 * single `GET /search`. Products and artists come from discover's port
 * (implemented by products); collectors from this module's own IUserSearch
 * port (implemented by users).
 *
 * The module also owns the search-index outbox schema under ./prisma, which
 * shared/database merges into the generated schema.
 */
export const MODULE_NAME = "search" as const;

// Module factory
export { createSearchModule } from './module';
export type { SearchModule, SearchModuleDeps } from './module';

// Constants
export {
    SEARCH_ALL_DEFAULT_LIMIT,
    SEARCH_ALL_MAX_LIMIT,
    SEARCH_MODULE,
    SEARCH_RATE_LIMIT,
    SEARCH_TYPE_DEFAULT_LIMIT,
    SEARCH_TYPE_MAX_LIMIT,
} from './constants/search.constant';

// Domain — the port the users module implements
export type {
    IUserSearch,
    SearchUserItem,
    UserSearchQuery,
    UserSearchResult,
} from './domain/interfaces/user-search.interface';

// Service
export { SearchService, normaliseSearchText } from './service/search.service';
export type { SearchRequest } from './service/search.service';

// DTOs
export { SEARCH_TYPES, searchQuerySchema } from './dto/search.dto';
export type {
    SearchQueryDto,
    SearchResultDto,
    SearchSection,
    SearchType,
} from './dto/search.dto';
