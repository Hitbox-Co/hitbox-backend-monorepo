import { Prisma } from '@hitbox/database';
import { DiscoverSection } from '@hitbox/discover';
import type {
    DiscoverProductItem,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from '@hitbox/discover';
import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { ProductDiscoverRow, ProductRepository } from '../repository/product.repository';
import { PUBLIC_PRODUCT_WHERE } from '../repository/product.repository';

/**
 * Products-side implementation of discover's IProductDiscovery port —
 * same pattern as users implementing auth's IAccountLookup.
 *
 * The screen's sections used to map onto `Product.marketplaceStatus`, a
 * curation column the catalog restructure removed. With nothing editorial
 * left in the schema, each section is now expressed as an ordering over data
 * that does exist:
 *
 *   TRENDING      most minted SKUs   (was: marketplaceStatus = TRENDING_NOW)
 *   NEW_RELEASES  newest first       (unchanged in spirit)
 *   TOP_CREATORS  most minted SKUs   (was: marketplaceStatus = TOP_CREATORS)
 *
 * TRENDING and TOP_CREATORS therefore return the same order today. That is
 * honest rather than clever: re-separating them needs a real signal — a
 * curation column, or sales/view counters — not a different arbitrary sort.
 */

const sectionToOrderBy: Record<DiscoverSection, Prisma.ProductOrderByWithRelationInput> = {
    [DiscoverSection.TRENDING]: { skus: { _count: 'desc' } },
    [DiscoverSection.NEW_RELEASES]: { createdAt: 'desc' },
    [DiscoverSection.TOP_CREATORS]: { skus: { _count: 'desc' } },
};

export class ProductDiscoveryAdapter implements IProductDiscovery {
    constructor(
        private readonly products: ProductRepository,
        private readonly mediaUrls?: IMediaUrlResolver | undefined,
    ) { }

    async findProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult> {
        const where: Prisma.ProductWhereInput = {
            ...PUBLIC_PRODUCT_WHERE,
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const { items, total } = await this.products.findForDiscover({
            where,
            orderBy: query.section ? sectionToOrderBy[query.section] : { createdAt: 'desc' },
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        return { items: items.map((row) => this.toItem(row)), total };
    }

    private toItem(row: ProductDiscoverRow): DiscoverProductItem {
        const ref = row.productImages[0]?.asset.storageRef;
        return {
            id: row.id,
            name: row.name,
            imageUrl: ref ? (this.mediaUrls?.publicUrl(ref) ?? null) : null,
        };
    }
}
