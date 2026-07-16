import { Prisma, ProductState } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListProductsQuery } from '../dto/product.dto';

const listInclude = {
    images: true,
    collection: { include: { artist: true } },
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof listInclude }>;

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
