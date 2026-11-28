import { z } from 'zod';
import {
    DISCOVER_DEFAULT_PAGE_SIZE,
    DISCOVER_MAX_PAGE_SIZE,
} from '../constants/discover.constant';
import { DiscoverCategory } from '../domain/enums/discover-category.enum';
import { DiscoverSection } from '../domain/enums/discover-section.enum';
import type {
    DiscoverCreatorItem,
    DiscoverProductItem,
} from '../domain/interfaces/product-discovery.interface';

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(DISCOVER_MAX_PAGE_SIZE)
        .default(DISCOVER_DEFAULT_PAGE_SIZE),
};

export const discoverFeedQuerySchema = z.object({
    category: z.nativeEnum(DiscoverCategory).optional(),
    /** Never an error: a non-uuid, unknown or inactive market is ignored. */
    marketId: z.string().uuid().optional().catch(undefined),
});

export const discoverProductsQuerySchema = z.object({
    section: z.nativeEnum(DiscoverSection).optional(),
    category: z.nativeEnum(DiscoverCategory).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    /** Never an error: a non-uuid, unknown or inactive market is ignored. */
    marketId: z.string().uuid().optional().catch(undefined),
    ...pagination,
});

export const discoverCreatorsQuerySchema = z.object({
    search: z.string().trim().min(1).max(100).optional(),
    ...pagination,
});

export type DiscoverFeedQueryDto = z.infer<typeof discoverFeedQuerySchema>;
export type DiscoverProductsQueryDto = z.infer<typeof discoverProductsQuerySchema>;
export type DiscoverCreatorsQueryDto = z.infer<typeof discoverCreatorsQuerySchema>;

/** One round-trip for the whole Discover screen. */
export interface DiscoverFeedDto {
    /** Hero carousel. */
    featured: DiscoverProductItem[];
    /** "Trending now". */
    trending: DiscoverProductItem[];
    /** "Meet the creators" — not filtered by category. */
    creators: DiscoverCreatorItem[];
    /** "Latest drops". */
    newReleases: DiscoverProductItem[];
}
