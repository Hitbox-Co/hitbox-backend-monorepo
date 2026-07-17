import { MarketplaceStatus, Prisma, ProductState } from '@hitbox/database';
import { DiscoverSection } from '@hitbox/discover';
import type {
    DiscoverProductItem,
    DiscoverProductsQuery,
    DiscoverProductsResult,
    IProductDiscovery,
} from '@hitbox/discover';
import type { ProductDiscoverRow, ProductRepository } from '../repository/product.repository';

/**
 * Products-side implementation of discover's IProductDiscovery port —
 * same pattern as users implementing auth's IAccountLookup. Maps the
 * screen-level DiscoverSection onto storage concerns (MarketplaceStatus,
 * ordering) that only this module is allowed to know about.
 */

const sectionToStatus: Record<DiscoverSection, MarketplaceStatus> = {
    [DiscoverSection.TRENDING]: MarketplaceStatus.TRENDING_NOW,
    [DiscoverSection.NEW_RELEASES]: MarketplaceStatus.NEW_RELEASE,
    [DiscoverSection.TOP_CREATORS]: MarketplaceStatus.TOP_CREATORS,
};

const sectionToOrderBy: Record<DiscoverSection, Prisma.ProductOrderByWithRelationInput> = {
    [DiscoverSection.TRENDING]: { unitsSold: 'desc' },
    [DiscoverSection.NEW_RELEASES]: { createdAt: 'desc' },
    [DiscoverSection.TOP_CREATORS]: { unitsSold: 'desc' },
};

function toItem(row: ProductDiscoverRow): DiscoverProductItem {
    return {
        id: row.id,
        name: row.name,
        imageUrl: row.images[0]?.url ?? null,
        rewardPoints: row.rewardPoints,
    };
}

export class ProductDiscoveryAdapter implements IProductDiscovery {
    constructor(private readonly products: ProductRepository) { }

    async findProducts(query: DiscoverProductsQuery): Promise<DiscoverProductsResult> {
        const where: Prisma.ProductWhereInput = {
            state: ProductState.ACTIVE,
            ...(query.section && { marketplaceStatus: sectionToStatus[query.section] }),
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

        return { items: items.map(toItem), total };
    }
}
