import type { PrismaClient } from '@hitbox/database';

export interface ArtistCollectionCapacityRow {
    collectionId: string;
    maximumLimit: number;
}

/**
 * Reads of the artist module's own ArtistCollection table.
 */
export class ArtistCollectionRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** maximumLimit for each of the given collections (unknown ids omitted). */
    async findCapacities(collectionIds: string[]): Promise<ArtistCollectionCapacityRow[]> {
        if (collectionIds.length === 0) return [];
        const rows = await this.prisma.artistCollection.findMany({
            where: { id: { in: collectionIds } },
            select: { id: true, maximumLimit: true },
        });
        return rows.map((row) => ({ collectionId: row.id, maximumLimit: row.maximumLimit }));
    }
}
