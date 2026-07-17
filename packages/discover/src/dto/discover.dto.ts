import { z } from 'zod';
import {
    DISCOVER_DEFAULT_PAGE_SIZE,
    DISCOVER_MAX_PAGE_SIZE,
} from '../constants/discover.constant';
import { DiscoverSection } from '../domain/enums/discover-section.enum';
import type { DiscoverProductItem } from '../domain/interfaces/product-discovery.interface';

export const discoverProductsQuerySchema = z.object({
    section: z.nativeEnum(DiscoverSection).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(DISCOVER_MAX_PAGE_SIZE)
        .default(DISCOVER_DEFAULT_PAGE_SIZE),
});

export type DiscoverProductsQueryDto = z.infer<typeof discoverProductsQuerySchema>;

/** One round-trip for the whole Discover screen. */
export interface DiscoverFeedDto {
    featured: DiscoverProductItem[];
    trending: DiscoverProductItem[];
    newReleases: DiscoverProductItem[];
    topCreators: DiscoverProductItem[];
}
