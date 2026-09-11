import { Prisma, Visibility } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListCollectionQueryDto } from '../dto/collection.dto';

/**
 * The only place in this module that touches Prisma.
 *
 * **A shelf row points at a SKU, not a product.** `BuyerCollection.productId`
 * became `skuId` in the restructure, which is the correct shape: a buyer owns
 * serialized item #14 of an edition, not "the product" in the abstract. The
 * product card is therefore reached as `sku.product`, one hop further than
 * before.
 *
 * `BuyerCollection` declares the `sku` relation in its OWN partial
 * (collections.prisma), so traversing that is reading this module's own
 * schema. `sku.product` crosses into the skus and products partials — a
 * documented, deliberate shortcut at the database layer. On extraction both
 * hops become a port call and only this file changes.
 */
const itemInclude = {
    sku: {
        select: {
            id: true,
            skuCode: true,
            serialNumber: true,
            claimedStatus: true,
            product: {
                select: {
                    id: true,
                    name: true,
                    rarity: true,
                    collectionId: true,
                    productImages: {
                        where: { archivedAt: null },
                        orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
                        take: 1,
                        select: { asset: { select: { storageRef: true } } },
                    },
                },
            },
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
            // `archivedAt` is new on this table — a removed shelf item keeps its
            // row (the SKU's provenance outlives the shelf placement) so every
            // read has to exclude it explicitly.
            archivedAt: null,
            ...(options.publicOnly
                ? { visibility: Visibility.PUBLIC }
                : query.visibility && { visibility: query.visibility }),
        };

        const [items, total] = await this.prisma.$transaction([
            this.prisma.buyerCollection.findMany({
                where,
                include: itemInclude,
                // Was `createdAt`, which this table no longer has. `acquiredAt`
                // is the same idea and more precise: when it reached the shelf.
                orderBy: { acquiredAt: 'desc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.buyerCollection.count({ where }),
        ]);

        return { items, total };
    }

    /**
     * Aggregation feeding the Collections stats section. Counts are derived
     * from the actual rows, and reach `product.collectionId` through
     * `sku.product` — the same two hops the item projection uses.
     *
     * A user's collection is bounded (tens–hundreds of items), so one
     * projected findMany is cheaper than several round-trips; if it ever
     * grows unbounded, swap this for a grouped/raw count.
     */
    async aggregateForStats(userId: string): Promise<{
        totalClaimedItems: number;
        ownedInCollections: number;
        collectionIds: string[];
    }> {
        const rows = await this.prisma.buyerCollection.findMany({
            where: { userId, archivedAt: null },
            select: { sku: { select: { product: { select: { collectionId: true } } } } },
        });

        const collectionIds = new Set<string>();
        let ownedInCollections = 0;
        for (const row of rows) {
            const collectionId = row.sku.product.collectionId;
            if (collectionId) {
                collectionIds.add(collectionId);
                ownedInCollections += 1;
            }
        }

        return {
            totalClaimedItems: rows.length,
            ownedInCollections,
            collectionIds: [...collectionIds],
        };
    }

    /** Keyed by SKU: the unique is `@@unique([userId, skuId])`. */
    findItem(userId: string, skuId: string): Promise<BuyerCollectionRow | null> {
        return this.prisma.buyerCollection.findUnique({
            where: { userId_skuId: { userId, skuId } },
            include: itemInclude,
        });
    }

    updateVisibility(id: string, visibility: Visibility): Promise<BuyerCollectionRow> {
        return this.prisma.buyerCollection.update({
            where: { id },
            data: { visibility },
            include: itemInclude,
        });
    }
}
