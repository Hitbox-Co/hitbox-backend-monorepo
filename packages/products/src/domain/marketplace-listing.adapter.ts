import { MarketplaceStatus, Prisma, ProductCategory, ProductState } from '@hitbox/database';
import { MarketplaceCategory } from '@hitbox/marketplace';
import type {
    IListingCatalog,
    ListingBadge,
    MarketplaceListingItem,
    MarketplaceListingsQuery,
    MarketplaceListingsResult,
    MarketplaceSort,
} from '@hitbox/marketplace';
import type { ProductListingRow, ProductRepository } from '../repository/product.repository';

/**
 * Products-side implementation of marketplace's IListingCatalog port.
 * Maps the screen-level category tabs and badges onto storage concerns
 * (ProductCategory sets, MarketplaceStatus) that only this module knows.
 */

const categoryToProductCategories: Record<MarketplaceCategory, ProductCategory[]> = {
    [MarketplaceCategory.CARDS]: [ProductCategory.TRADING_CARD, ProductCategory.CARD_PACK],
    [MarketplaceCategory.FIGURES]: [ProductCategory.FIGURE],
    [MarketplaceCategory.APPAREL]: [ProductCategory.JERSEY, ProductCategory.ACCESSORY],
    [MarketplaceCategory.POSTERS]: [ProductCategory.POSTER],
    [MarketplaceCategory.DIGITAL]: [ProductCategory.DIGITAL_ASSET],
    [MarketplaceCategory.OTHER]: [
        ProductCategory.BOOK,
        ProductCategory.AUTOGRAPH,
        ProductCategory.GAME_BOX,
        ProductCategory.OTHER,
    ],
};

const sortToOrderBy: Record<MarketplaceSort, Prisma.ProductOrderByWithRelationInput> = {
    newest: { createdAt: 'desc' },
    price_asc: { priceInDollars: 'asc' },
    price_desc: { priceInDollars: 'desc' },
    popular: { unitsSold: 'desc' },
};

function toBadge(status: MarketplaceStatus | null): ListingBadge {
    if (status === MarketplaceStatus.TRENDING_NOW) return 'HOT';
    if (status === MarketplaceStatus.NEW_RELEASE) return 'NEW';
    return null;
}

function toItem(row: ProductListingRow): MarketplaceListingItem {
    return {
        id: row.id,
        name: row.name,
        imageUrl: row.images[0]?.url ?? null,
        artistName: row.collection?.artist.name ?? null,
        priceInDollars: row.priceInDollars.toString(),
        rewardPoints: row.rewardPoints,
        badge: toBadge(row.marketplaceStatus),
    };
}

export class MarketplaceListingAdapter implements IListingCatalog {
    constructor(private readonly products: ProductRepository) { }

    async findListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult> {
        const where: Prisma.ProductWhereInput = {
            state: ProductState.ACTIVE,
            ...(query.featuredOnly && { marketplaceStatus: { not: null } }),
            ...(query.category && {
                category: { in: categoryToProductCategories[query.category] },
            }),
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const { items, total } = await this.products.findForMarketplace({
            where,
            orderBy: sortToOrderBy[query.sort],
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });

        return { items: items.map(toItem), total };
    }
}
