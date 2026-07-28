import { Prisma, ProductState } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ProductCache } from '../cache/product-cache';
import type { ListProductsQuery } from '../dto/product.dto';

const listInclude = {
    images: true,
    collection: { include: { artist: true } },
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof listInclude }>;

const discoverSelect = {
    id: true,
    name: true,
    rewardPoints: true,
    images: { take: 1, select: { url: true } },
} satisfies Prisma.ProductSelect;

export type ProductDiscoverRow = Prisma.ProductGetPayload<{ select: typeof discoverSelect }>;

const marketplaceSelect = {
    id: true,
    name: true,
    rewardPoints: true,
    priceInDollars: true,
    marketplaceStatus: true,
    images: { take: 1, select: { url: true } },
    collection: { select: { artist: { select: { name: true } } } },
} satisfies Prisma.ProductSelect;

export type ProductListingRow = Prisma.ProductGetPayload<{ select: typeof marketplaceSelect }>;

const historySelect = {
    id: true,
    price: true,
    ownershipStartDate: true,
    ownershipEndDate: true,
    ownerId: true,
} satisfies Prisma.ProductHistorySelect;

export type ProductHistoryRow = Prisma.ProductHistoryGetPayload<{ select: typeof historySelect }>;

const sortToOrderBy: Record<ListProductsQuery['sort'], Prisma.ProductOrderByWithRelationInput> = {
    newest: { createdAt: 'desc' },
    price_asc: { priceInDollars: 'asc' },
    price_desc: { priceInDollars: 'desc' },
    popular: { unitsSold: 'desc' },
};

export class ProductRepository {
    constructor(
        private readonly prisma: PrismaClient,
        private readonly cache: ProductCache,
    ) { }

    async findMany(query: ListProductsQuery): Promise<{ items: ProductWithRelations[]; total: number }> {
        type Result = { items: ProductWithRelations[]; total: number };
        const cached = await this.cache.getList<Result>('catalog', query);
        if (cached) return cached;

        const where: Prisma.ProductWhereInput = {
            state: ProductState.ACTIVE,
            ...(query.category && { category: query.category }),
            ...(query.genre && { genre: query.genre }),
            ...(query.type && { type: query.type }),
            ...(query.rarity && { rarity: query.rarity }),
            ...(query.marketplaceStatus && { marketplaceStatus: query.marketplaceStatus }),
            ...(query.collectionId && { collectionId: query.collectionId }),
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where,
                include: listInclude,
                orderBy: sortToOrderBy[query.sort],
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

        const product = await this.prisma.product.findUnique({ where: { id }, include: listInclude });
        if (product) await this.cache.setEntity('id', id, product);
        return product;
    }

    async findByProductCode(productCode: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('code', productCode);
        if (cached) return cached;

        const product = await this.prisma.product.findUnique({
            where: { productCode },
            include: listInclude,
        });
        if (product) await this.cache.setEntity('code', productCode, product);
        return product;
    }

    findByTagId(tagId: string): Promise<ProductWithRelations | null> {
        return this.prisma.product.findUnique({ where: { tagId }, include: listInclude });
    }

    /** Ownership/price periods for a product, most recent first. */
    findHistory(productId: string): Promise<ProductHistoryRow[]> {
        return this.prisma.productHistory.findMany({
            where: { productId },
            orderBy: { ownershipStartDate: 'desc' },
            select: historySelect,
        });
    }

    create(data: Prisma.ProductCreateInput): Promise<ProductWithRelations> {
        return this.prisma.product.create({ data, include: listInclude });
    }

    async update(id: string, data: Prisma.ProductUpdateInput): Promise<ProductWithRelations> {
        const product = await this.prisma.product.update({ where: { id }, data, include: listInclude });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.productCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }

    /** Soft archive — products are never hard-deleted (provenance!). */
    async archive(id: string): Promise<ProductWithRelations> {
        const product = await this.prisma.product.update({
            where: { id },
            data: { state: ProductState.INACTIVE },
            include: listInclude,
        });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.productCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }
}
