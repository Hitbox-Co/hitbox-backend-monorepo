import { z } from 'zod';
import {
    MARKETPLACE_DEFAULT_PAGE_SIZE,
    MARKETPLACE_MAX_PAGE_SIZE,
} from '../constants/marketplace.constant';
import { MarketplaceCategory } from '../domain/enums/marketplace-category.enum';
import type { MarketplaceListingItem } from '../domain/interfaces/listing-catalog.interface';

export const marketplaceListingsQuerySchema = z.object({
    category: z.nativeEnum(MarketplaceCategory).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MARKETPLACE_MAX_PAGE_SIZE)
        .default(MARKETPLACE_DEFAULT_PAGE_SIZE),
});

export type MarketplaceListingsQueryDto = z.infer<typeof marketplaceListingsQuerySchema>;

/** One round-trip for the whole Marketplace screen. */
export interface MarketplaceFeedDto {
    featured: MarketplaceListingItem[];
    newListings: MarketplaceListingItem[];
}
