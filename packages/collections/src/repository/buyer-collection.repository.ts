import { CollectionVisibility, Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListCollectionQueryDto } from '../dto/collection.dto';

/**
 * Note on the `product` include: BuyerCollection declares this relation in
 * its OWN partial (collections.prisma), so traversing it here is reading the
 * module's own schema. When collections is extracted into a service, this
 * include becomes a products-port call — the repository is the only file
 * that changes.
 */
const itemInclude = {
    product: {
        select: {
            id: true,
            name: true,
            rarity: true,
            rewardPoints: true,
            claimedStatus: true,
            images: { take: 1, select: { url: true } },
        },
    },
} satisfies Prisma.BuyerCollectionInclude;

export type BuyerCollectionRow = Prisma.BuyerCollectionGetPayload<{ include: typeof itemInclude }>;

export class BuyerCollectionRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async findManyByUser(
        userId: string,
        query: ListCollectionQueryDto,
        options: { publicOnly?: boolean } = {},
    ): Promise<{ items: BuyerCollectionRow[]; total: number }> {
        const where: Prisma.BuyerCollectionWhereInput = {
            userId,
            ...(options.publicOnly
                ? { visibility: CollectionVisibility.PUBLIC }
                : query.visibility && { visibility: query.visibility }),
            ...(query.genre && { genre: query.genre }),
        };

        const [items, total] = await this.prisma.$transaction([
            this.prisma.buyerCollection.findMany({
                where,
                include: itemInclude,
                orderBy: { createdAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.buyerCollection.count({ where }),
        ]);

        return { items, total };
    }

    findItem(userId: string, productId: string): Promise<BuyerCollectionRow | null> {
        return this.prisma.buyerCollection.findUnique({
            where: { userId_productId: { userId, productId } },
            include: itemInclude,
        });
    }

    updateVisibility(
        id: string,
        visibility: CollectionVisibility,
    ): Promise<BuyerCollectionRow> {
        return this.prisma.buyerCollection.update({
            where: { id },
            data: { visibility },
            include: itemInclude,
        });
    }
}
