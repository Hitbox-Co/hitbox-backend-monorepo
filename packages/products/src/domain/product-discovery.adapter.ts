import { Prisma } from '@hitbox/database';
import { DiscoverSection } from '@hitbox/discover';
import type {
    DiscoverCreatorsQuery,
    DiscoverCreatorsResult,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from '@hitbox/discover';
import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { ProductRepository } from '../repository/product.repository';
import { PUBLIC_PRODUCT_WHERE } from '../repository/product.repository';
import { toDropCard } from './drop-card';
import { STORAGE_CATEGORIES_BY_TAB } from './storage-categories';

/**
 * Products-side implementation of discover's IProductDiscovery port —
 * same pattern as users implementing auth's IAccountLookup.
 *
 * Nothing editorial is left in the schema (the old `marketplaceStatus`
 * curation column is gone), so each section is an ordering — and for the
 * hero, a filter — over data that does exist:
 *
 *   FEATURED      top rarity tiers, most minted SKUs first
 *   TRENDING      most minted SKUs first
 *   NEW_RELEASES  newest first
 */

/**
 * `Drop.rarity` is free-form, so the hero matches these case-insensitively.
 * A drop with any other rarity (or none) never appears in the hero.
 */
const FEATURED_RARITIES = ['LEGENDARY', 'MYTHIC', 'ULTRA_RARE', 'ULTRA RARE', 'EPIC'];

const mostMinted: Prisma.DropOrderByWithRelationInput[] = [
    { skus: { _count: 'desc' } },
    { createdAt: 'desc' },
];

const sectionToOrderBy: Record<DiscoverSection, Prisma.DropOrderByWithRelationInput[]> = {
    [DiscoverSection.FEATURED]: mostMinted,
    [DiscoverSection.TRENDING]: mostMinted,
    [DiscoverSection.NEW_RELEASES]: [{ createdAt: 'desc' }],
};

export class ProductDiscoveryAdapter implements IProductDiscovery {
    constructor(
        private readonly products: ProductRepository,
        private readonly mediaUrls?: IMediaUrlResolver | undefined,
    ) { }

    async findProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult> {
        const where: Prisma.DropWhereInput = {
            ...PUBLIC_PRODUCT_WHERE,
            ...(query.section === DiscoverSection.FEATURED && {
                rarity: { in: FEATURED_RARITIES, mode: Prisma.QueryMode.insensitive },
            }),
            ...(query.category && {
                category: { in: STORAGE_CATEGORIES_BY_TAB[query.category] },
            }),
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const { items, total } = await this.products.findForDiscover({
            where,
            orderBy: query.section ? sectionToOrderBy[query.section] : [{ createdAt: 'desc' }],
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        // Rows are cached across users; the wishlist overlay is per-viewer and
        // is therefore looked up after, never stored with them.
        const wishlisted = query.viewerId
            ? await this.products.findWishlistedProductIds(query.viewerId, items.map((row) => row.id))
            : null;

        return { items: items.map((row) => toDropCard(row, this.mediaUrls, wishlisted)), total };
    }

    async findCreators(query: DiscoverCreatorsQuery): Promise<DiscoverCreatorsResult> {
        return this.products.findCreatorsForDiscover({
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
    }
}
