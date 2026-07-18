import { Prisma, ProductState } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
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

const sortToOrderBy: Record<ListProductsQuery['sort'], Prisma.ProductOrderByWithRelationInput> = {
    newest: { createdAt: 'desc' },
    price_asc: { priceInDollars: 'asc' },
    price_desc: { priceInDollars: 'desc' },
    popular: { unitsSold: 'desc' },
};

export class ProductRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async findMany(query: ListProductsQuery): Promise<{ items: ProductWithRelations[]; total: number }> {
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

        return { items, total };
    }

    /** Minimal card projection for the discover feed — no joins beyond one image. */
    async findForDiscover(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductDiscoverRow[]; total: number }> {
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
        return { items, total };
    }

    /** Listing card projection for the marketplace feed — price + artist name. */
    async findForMarketplace(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductListingRow[]; total: number }> {
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
        return { items, total };
    }

    findById(id: string): Promise<ProductWithRelations | null> {
        return this.prisma.product.findUnique({ where: { id }, include: listInclude });
    }

    findByProductCode(productCode: string): Promise<ProductWithRelations | null> {
        return this.prisma.product.findUnique({ where: { productCode }, include: listInclude });
    }

    create(data: Prisma.ProductCreateInput): Promise<ProductWithRelations> {
        return this.prisma.product.create({ data, include: listInclude });
    }

    update(id: string, data: Prisma.ProductUpdateInput): Promise<ProductWithRelations> {
        return this.prisma.product.update({ where: { id }, data, include: listInclude });
    }

    /** Soft archive — products are never hard-deleted (provenance!). */
    archive(id: string): Promise<ProductWithRelations> {
        return this.prisma.product.update({
            where: { id },
            data: { state: ProductState.INACTIVE },
            include: listInclude,
        });
    }
}
