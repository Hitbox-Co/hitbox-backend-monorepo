import { DropStatus, Prisma } from '@hitbox/database';
import { MarketplaceCategory } from '@hitbox/marketplace';
import type {
    IListingCatalog,
    MarketplaceListingItem,
    MarketplaceListingsQuery,
    MarketplaceListingsResult,
    MarketplaceSort,
} from '@hitbox/marketplace';
import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { ProductListingRow, ProductRepository } from '../repository/product.repository';
import { PUBLIC_PRODUCT_WHERE } from '../repository/product.repository';

/**
 * Products-side implementation of marketplace's IListingCatalog port.
 * Maps the screen-level category tabs onto storage concerns only this
 * module knows about.
 *
 * `Product.category` is a free-form `String?` since the catalog restructure —
 * the `ProductCategory` enum it used to map onto no longer exists. The tab
 * mapping is therefore string-valued, and the values below are the contract
 * with whoever populates `category`. A product whose category is not in any
 * list is reachable only from the "All Items" tab, which is why OTHER is a
 * fallback list rather than a catch-all.
 */

const categoryToStorageCategories: Record<MarketplaceCategory, string[]> = {
    [MarketplaceCategory.CARDS]: ['TRADING_CARD', 'CARD_PACK'],
    [MarketplaceCategory.FIGURES]: ['FIGURE'],
    [MarketplaceCategory.APPAREL]: ['JERSEY', 'ACCESSORY'],
    [MarketplaceCategory.POSTERS]: ['POSTER'],
    [MarketplaceCategory.DIGITAL]: ['DIGITAL_ASSET'],
    [MarketplaceCategory.OTHER]: ['BOOK', 'AUTOGRAPH', 'GAME_BOX', 'OTHER'],
};

const sortToOrderBy: Record<MarketplaceSort, Prisma.ProductOrderByWithRelationInput> = {
    newest: { createdAt: 'desc' },
    popular: { skus: { _count: 'desc' } },
};

export class MarketplaceListingAdapter implements IListingCatalog {
    constructor(
        private readonly products: ProductRepository,
        private readonly mediaUrls?: IMediaUrlResolver | undefined,
    ) { }

    async findListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult> {
        const where: Prisma.ProductWhereInput = {
            ...PUBLIC_PRODUCT_WHERE,
            // "Featured" was `marketplaceStatus != null`, a curation column the
            // restructure removed. The nearest honest equivalent is a drop
            // that has actually opened — already implied by PUBLIC_PRODUCT_WHERE,
            // so this narrows to one inside a declared release window.
            ...(query.featuredOnly && {
                status: DropStatus.ACTIVE,
                releaseStart: { not: null },
            }),
            ...(query.category && {
                category: { in: categoryToStorageCategories[query.category] },
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

        return { items: items.map((row) => this.toItem(row)), total };
    }

    private toItem(row: ProductListingRow): MarketplaceListingItem {
        const ref = row.productImages[0]?.asset.storageRef;
        // At most one row: the base price (variantId null) of the default
        // market, guaranteed unique by @@unique([productId, variantId, marketId]).
        const price = row.productPrices[0];
        return {
            id: row.id,
            name: row.name,
            imageUrl: ref ? (this.mediaUrls?.publicUrl(ref) ?? null) : null,
            artistName: row.artist?.name ?? row.collection?.artist.name ?? null,
            priceInDollars: price ? (price.isFree ? '0' : (price.amount?.toString() ?? null)) : null,
            currency: price?.market.currency ?? null,
        };
    }
}
