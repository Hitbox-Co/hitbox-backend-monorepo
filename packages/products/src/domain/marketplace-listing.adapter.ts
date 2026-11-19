import { DropStatus, Prisma } from '@hitbox/database';
import { MarketplaceCategory } from '@hitbox/marketplace';
import type {
    IListingCatalog,
    MarketplaceListingsQuery,
    MarketplaceListingsResult,
    MarketplaceSort,
} from '@hitbox/marketplace';
import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { ProductRepository } from '../repository/product.repository';
import { PUBLIC_PRODUCT_WHERE } from '../repository/product.repository';
import { toDropCard } from './drop-card';
import { STORAGE_CATEGORIES_BY_TAB } from './storage-categories';

/**
 * Products-side implementation of marketplace's IListingCatalog port.
 * Maps the screen-level category tabs onto storage concerns only this
 * module knows about.
 *
 * The tab → `Drop.category` mapping is shared with discover — see
 * `storage-categories.ts`.
 */

const categoryToStorageCategories: Record<MarketplaceCategory, string[]> = STORAGE_CATEGORIES_BY_TAB;

const sortToOrderBy: Record<MarketplaceSort, Prisma.DropOrderByWithRelationInput[]> = {
    newest: [{ createdAt: 'desc' }],
    // Ties broken by newest, so a page boundary never reshuffles equal counts.
    popular: [{ skus: { _count: 'desc' } }, { createdAt: 'desc' }],
};

export class MarketplaceListingAdapter implements IListingCatalog {
    constructor(
        private readonly products: ProductRepository,
        private readonly mediaUrls?: IMediaUrlResolver | undefined,
    ) { }

    async findListings(query: MarketplaceListingsQuery): Promise<MarketplaceListingsResult> {
        const where: Prisma.DropWhereInput = {
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

        // Rows are cached across users; the wishlist overlay is per-viewer and
        // is therefore looked up after, never stored with them.
        const wishlisted = query.viewerId
            ? await this.products.findWishlistedProductIds(query.viewerId, items.map((row) => row.id))
            : null;

        return { items: items.map((row) => toDropCard(row, this.mediaUrls, wishlisted)), total };
    }
}
