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

    /**
     * How many items each collection holds (unknown ids omitted).
     *
     * This used to read `ArtistCollection.maximumLimit`, a declared capacity
     * column that no longer exists — it was dropped in the catalog restructure
     * and this file was never updated, so the package stopped compiling.
     *
     * The replacement is the **count of products filed under the collection**,
     * which is the only capacity the schema still records. Note the meaning
     * shifts slightly: the old column was a *declaration* ("this set will have
     * 12 pieces") and this is a *fact* ("12 pieces exist"). For the buyer's
     * collection-progress stat — "you own 3 of 12" — the fact is arguably the
     * better denominator, but a collection that is still being filled will now
     * show 100% early. Restoring the declared figure needs the column back.
     */
    async findCapacities(collectionIds: string[]): Promise<ArtistCollectionCapacityRow[]> {
        if (collectionIds.length === 0) return [];
        const rows = await this.prisma.artistCollection.findMany({
            where: { id: { in: collectionIds } },
            select: { id: true, _count: { select: { drops: true } } },
        });
        return rows.map((row) => ({
            collectionId: row.id,
            maximumLimit: row._count.drops,
        }));
    }
}
