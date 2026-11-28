import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { RELEASED_DROP_STATUSES } from '../constants/collections.constant';

const RELEASED = { in: [...RELEASED_DROP_STATUSES] } as Prisma.EnumDropStatusFilter;

/** Only what a buyer may see: public, live, not deleted. */
const publicCollection: Prisma.ArtistCollectionWhereInput = {
    isPublic: true,
    isActive: true,
    archivedAt: null,
    artist: { isPublic: true, isActive: true, archivedAt: null },
};

const collectionSelect = {
    id: true,
    name: true,
    slug: true,
    description: true,
    heroImageUrl: true,
    artist: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ArtistCollectionSelect;

export type ArtistCollectionRow = Prisma.ArtistCollectionGetPayload<{ select: typeof collectionSelect }>;

/**
 * Reads behind the buyer's "how much of this collection do I own" screens.
 * Reaches into artist (collections) and skus (ownership) tables — the same
 * documented database-layer shortcut the shelf repository uses; on extraction
 * these become port calls and only this file changes.
 */
export class CollectionProgressRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findPublicArtist(artistId: string): Promise<{ id: string; name: string; slug: string } | null> {
        return this.prisma.artist.findFirst({
            where: { id: artistId, isPublic: true, isActive: true, archivedAt: null },
            select: { id: true, name: true, slug: true },
        });
    }

    async findArtistCollections(
        artistId: string,
        skip: number,
        take: number,
    ): Promise<{ items: ArtistCollectionRow[]; total: number }> {
        const where: Prisma.ArtistCollectionWhereInput = { ...publicCollection, artistId };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.artistCollection.findMany({
                where,
                select: collectionSelect,
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                skip,
                take,
            }),
            this.prisma.artistCollection.count({ where }),
        ]);
        return { items, total };
    }

    findPublicCollection(collectionId: string): Promise<ArtistCollectionRow | null> {
        return this.prisma.artistCollection.findFirst({
            where: { ...publicCollection, id: collectionId },
            select: collectionSelect,
        });
    }

    /**
     * The released drops of each collection, in release order — what a buyer
     * has to collect. Drafts and drops in review do not count.
     */
    async releasedDropIds(collectionIds: string[]): Promise<Map<string, string[]>> {
        const byCollection = new Map<string, string[]>(collectionIds.map((id) => [id, []]));
        if (collectionIds.length === 0) return byCollection;
        const rows = await this.prisma.drop.findMany({
            where: { collectionId: { in: collectionIds }, archivedAt: null, status: RELEASED },
            select: { id: true, collectionId: true },
            orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        });
        for (const row of rows) {
            if (row.collectionId) byCollection.get(row.collectionId)?.push(row.id);
        }
        return byCollection;
    }

    /** Which of `dropIds` the buyer owns a claimed unit of (the reward rule's definition of "own"). */
    async ownedDropIds(userId: string, dropIds: string[]): Promise<Set<string>> {
        if (dropIds.length === 0) return new Set();
        const rows = await this.prisma.sku.findMany({
            where: { ownerId: userId, claimedStatus: 'CLAIMED', productId: { in: dropIds } },
            select: { productId: true },
            distinct: ['productId'],
        });
        return new Set(rows.map((row) => row.productId));
    }
}
