import { DropStatus, Prisma, ProductPriceStatus } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ProductCache } from '../cache/product-cache';
import type { ListProductsQuery } from '../dto/product.dto';

/**
 * The only place in this module that touches Prisma.
 *
 * Two things changed shape in the catalog restructure and drive most of what
 * is below:
 *
 *   - **Images** are no longer a URL on the row. `ProductImage` joins to
 *     `MediaAsset`, so every projection selects `asset.storageRef` and the
 *     service turns it into a URL through `IMediaUrlResolver`.
 *   - **Price** is no longer a column. `ProductPrice` is scoped per
 *     (product, variant, market), so a feed with no market context reads the
 *     base price — `variantId: null` — of the default market. The
 *     `@@unique([productId, variantId, marketId])` constraint makes that at
 *     most one row, which is why `take: 1` is exact rather than arbitrary.
 */

/** Primary image first, then by position. Archived placements are excluded. */
const imageArgs = {
    where: { archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
    select: { asset: { select: { storageRef: true } } },
} satisfies Prisma.Product$productImagesArgs;

/** The one base price a market-less feed can legitimately show. */
const basePriceArgs = {
    where: {
        status: ProductPriceStatus.ACTIVE,
        variantId: null,
        market: { isDefault: true, isActive: true },
    },
    take: 1,
    select: {
        amount: true,
        isFree: true,
        market: { select: { currency: true, code: true } },
    },
} satisfies Prisma.Product$productPricesArgs;

const listInclude = {
    productImages: imageArgs,
    productPrices: basePriceArgs,
    productVariants: { where: { archivedAt: null }, orderBy: { position: 'asc' } },
    collection: { include: { artist: true } },
    artist: true,
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof listInclude }>;

const discoverSelect = {
    id: true,
    name: true,
    productImages: { ...imageArgs, take: 1 },
} satisfies Prisma.ProductSelect;

export type ProductDiscoverRow = Prisma.ProductGetPayload<{ select: typeof discoverSelect }>;

const marketplaceSelect = {
    id: true,
    name: true,
    productImages: { ...imageArgs, take: 1 },
    productPrices: basePriceArgs,
    collection: { select: { artist: { select: { name: true } } } },
    artist: { select: { name: true } },
} satisfies Prisma.ProductSelect;

export type ProductListingRow = Prisma.ProductGetPayload<{ select: typeof marketplaceSelect }>;

/**
 * Sort options the schema can actually express.
 *
 * `price_asc`/`price_desc` were removed: price moved to the market-scoped
 * `ProductPrice` table, and Prisma cannot order a query by a field on a
 * to-many relation. Restoring them needs either a denormalized base-price
 * column on `Product` or a raw-SQL join — see the module README note rather
 * than a silent fallback that orders by something else.
 *
 * `popular` was `Product.unitsSold`, which no longer exists. Total minted SKU
 * count is the nearest thing the schema records; it is a proxy for edition
 * size, not for sales, because Prisma cannot order by a *filtered* relation
 * count (claimed SKUs only).
 */
export const PRODUCT_SORTS = {
    newest: { createdAt: 'desc' },
    popular: { skus: { _count: 'desc' } },
} satisfies Record<string, Prisma.ProductOrderByWithRelationInput>;

export type ProductSort = keyof typeof PRODUCT_SORTS;

/**
 * What the public catalog may show: inside its release window, not
 * deactivated, not archived.
 *
 * Replaces `state: ProductState.ACTIVE`. `DropStatus.ACTIVE` alone is not
 * enough — `isActive` is a separate kill switch and `archivedAt` is the soft
 * delete, and a row can carry any combination.
 */
export const PUBLIC_PRODUCT_WHERE: Prisma.ProductWhereInput = {
    status: DropStatus.ACTIVE,
    isActive: true,
    archivedAt: null,
};

export class ProductRepository {
    constructor(
        private readonly prisma: PrismaClient,
        private readonly cache: ProductCache,
    ) { }

    async findMany(
        query: ListProductsQuery,
    ): Promise<{ items: ProductWithRelations[]; total: number }> {
        type Result = { items: ProductWithRelations[]; total: number };
        const cached = await this.cache.getList<Result>('catalog', query);
        if (cached) return cached;

        const where: Prisma.ProductWhereInput = {
            // An explicit status filter overrides the public default, so admin
            // tooling can list DRAFT/IN_REVIEW drops through the same method.
            ...(query.status ? { isActive: true, archivedAt: null, status: query.status } : PUBLIC_PRODUCT_WHERE),
            ...(query.category && { category: query.category }),
            ...(query.vertical && { vertical: query.vertical }),
            ...(query.rarity && { rarity: query.rarity }),
            ...(query.collectionId && { collectionId: query.collectionId }),
            ...(query.artistId && { artistId: query.artistId }),
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where,
                include: listInclude,
                orderBy: PRODUCT_SORTS[query.sort],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.product.count({ where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('catalog', query, result);
        return result;
    }

    /** Minimal card projection for the discover feed — no joins beyond one image. */
    async findForDiscover(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductDiscoverRow[]; total: number }> {
        type Result = { items: ProductDiscoverRow[]; total: number };
        const cached = await this.cache.getList<Result>('discover', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where: params.where,
                select: discoverSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.product.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('discover', params, result);
        return result;
    }

    /** Listing card projection for the marketplace feed — price + artist name. */
    async findForMarketplace(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductListingRow[]; total: number }> {
        type Result = { items: ProductListingRow[]; total: number };
        const cached = await this.cache.getList<Result>('marketplace', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where: params.where,
                select: marketplaceSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.product.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('marketplace', params, result);
        return result;
    }

    async findById(id: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('id', id);
        if (cached) return cached;

        const product = await this.prisma.product.findUnique({
            where: { id },
            include: listInclude,
        });
        if (product) await this.cache.setEntity('id', id, product);
        return product;
    }

    /**
     * Lookup by the product's public code.
     *
     * `Product.productCode` became `Product.groupCode` in the restructure —
     * same role (the unique, client-facing identifier), different column.
     */
    async findByGroupCode(groupCode: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('code', groupCode);
        if (cached) return cached;

        const product = await this.prisma.product.findUnique({
            where: { groupCode },
            include: listInclude,
        });
        if (product) await this.cache.setEntity('code', groupCode, product);
        return product;
    }

    create(data: Prisma.ProductCreateInput): Promise<ProductWithRelations> {
        return this.prisma.product.create({ data, include: listInclude });
    }

    async update(id: string, data: Prisma.ProductUpdateInput): Promise<ProductWithRelations> {
        const product = await this.prisma.product.update({
            where: { id },
            data: { ...data, updatedAt: new Date() },
            include: listInclude,
        });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.groupCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }

    /**
     * Soft archive — products are never hard-deleted (provenance!).
     *
     * Sets both `archivedAt` and `isActive: false`. The old single `state`
     * column expressed this in one value; the current schema splits the soft
     * delete from the kill switch, and leaving `isActive` true on an archived
     * row would make it visible to any query that checks only one of them.
     */
    async archive(id: string): Promise<ProductWithRelations> {
        const now = new Date();
        const product = await this.prisma.product.update({
            where: { id },
            data: { isActive: false, archivedAt: now, status: DropStatus.ARCHIVED, updatedAt: now },
            include: listInclude,
        });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.groupCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }
}
