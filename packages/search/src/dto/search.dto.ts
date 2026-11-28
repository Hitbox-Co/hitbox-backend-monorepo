import { z } from 'zod';
import type { DiscoverCreatorItem, DiscoverProductItem } from '@hitbox/discover';
import type { SearchUserItem } from '../domain/interfaces/user-search.interface';

export const SEARCH_TYPES = ['all', 'products', 'artists', 'users'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const searchQuerySchema = z.object({
    /** The text to look for. A leading "@" (typing a handle) is ignored. */
    q: z.string().trim().min(1).max(100),
    type: z.enum(SEARCH_TYPES).default('all'),
    /** Only used with a single `type`; `all` always returns the first page of each section. */
    page: z.coerce.number().int().min(1).default(1),
    /** Default and maximum depend on `type`; applied by the service. */
    limit: z.coerce.number().int().min(1).optional(),
    /** Never an error: a non-uuid, unknown or inactive market is ignored. */
    marketId: z.string().uuid().optional().catch(undefined),
});

export type SearchQueryDto = z.infer<typeof searchQuerySchema>;

export interface SearchSection<T> {
    items: T[];
    /** Every match, not just this page — "See all 42". */
    total: number;
}

export interface SearchResultDto {
    /** The text actually searched (trimmed, leading "@" removed). */
    query: string;
    type: SearchType;
    /** Page served (always 1 for `all`) and the page size applied to each section. */
    page: number;
    limit: number;
    /** `null` when the section was not requested (a single `type`). */
    products: SearchSection<DiscoverProductItem> | null;
    artists: SearchSection<DiscoverCreatorItem> | null;
    users: SearchSection<SearchUserItem> | null;
}
