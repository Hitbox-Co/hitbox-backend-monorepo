import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@hitbox/database';
import type { AdminListCollectionsQuery } from '../dto/artist-collection.dto';

export interface ArtistCollectionCapacityRow {
    collectionId: string;
    maximumLimit: number;
}

/** The columns every collection view is built from. */
const collectionSelect = {
    id: true,
    publicCode: true,
    name: true,
    slug: true,
    description: true,
    heroImageUrl: true,
    position: true,
    artistId: true,
    organizationId: true,
    isPublic: true,
    isActive: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    _count: {
        select: {
            drops: true,
        },
    },
} satisfies Prisma.ArtistCollectionSelect;

const adminSelect = {
    ...collectionSelect,
    artist: { select: { id: true, name: true, slug: true, isActive: true, archivedAt: true } },
    organization: { select: { id: true, name: true } },
} satisfies Prisma.ArtistCollectionSelect;

export type CollectionRow = Prisma.ArtistCollectionGetPayload<{ select: typeof collectionSelect }>;
export type AdminCollectionRow = Prisma.ArtistCollectionGetPayload<{ select: typeof adminSelect }>;

/**
 * The artist module's ArtistCollection table — the only place this feature
 * touches Prisma.
 *
 * "Live drops" (not archived) are counted separately from the plain relation
 * count because they are what blocks archiving a collection, and a filtered
 * `_count` cannot sit beside the unfiltered one under the same key.
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

    // ── The artist's own collections ────────────────────────────────────────

    listForArtist(artistId: string, status: 'live' | 'archived' | 'all'): Promise<CollectionRow[]> {
        return this.prisma.artistCollection.findMany({
            where: { artistId, ...archivedFilter(status) },
            // Live ones by display order; archived ones after, newest first.
            orderBy: [{ archivedAt: { sort: 'desc', nulls: 'first' } }, { position: 'asc' }, { createdAt: 'asc' }],
            select: collectionSelect,
        });
    }

    /** Scoped to the artist: another artist's id is simply not found. */
    findForArtist(artistId: string, collectionId: string): Promise<CollectionRow | null> {
        return this.prisma.artistCollection.findFirst({
            where: { id: collectionId, artistId },
            select: collectionSelect,
        });
    }

    countLive(artistId: string): Promise<number> {
        return this.prisma.artistCollection.count({ where: { artistId, archivedAt: null } });
    }

    /** Live-drop counts per collection, for the views and the archive guard. */
    async liveDropCounts(collectionIds: string[]): Promise<Map<string, number>> {
        if (collectionIds.length === 0) return new Map();
        const rows = await this.prisma.drop.groupBy({
            by: ['collectionId'],
            where: { collectionId: { in: collectionIds }, archivedAt: null },
            _count: { _all: true },
        });
        return new Map(rows.map((row) => [row.collectionId as string, row._count._all]));
    }

    async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
        const row = await this.prisma.artistCollection.findUnique({ where: { slug }, select: { id: true } });
        return row !== null && row.id !== exceptId;
    }

    /** Case-insensitive name clash among the artist's LIVE collections. */
    async nameTaken(artistId: string, name: string, exceptId?: string): Promise<boolean> {
        const row = await this.prisma.artistCollection.findFirst({
            where: {
                artistId,
                archivedAt: null,
                name: { equals: name, mode: 'insensitive' },
                ...(exceptId ? { id: { not: exceptId } } : {}),
            },
            select: { id: true },
        });
        return row !== null;
    }

    /** The next free position at the end of the artist's live list. */
    async nextPosition(artistId: string): Promise<number> {
        const result = await this.prisma.artistCollection.aggregate({
            where: { artistId, archivedAt: null },
            _max: { position: true },
        });
        return (result._max.position ?? -1) + 1;
    }

    create(input: {
        artistId: string;
        organizationId: string | null;
        name: string;
        slug: string;
        description: string | null;
        isPublic: boolean;
        position: number;
    }): Promise<CollectionRow> {
        const now = new Date();
        return this.prisma.artistCollection.create({
            data: {
                id: randomUUID(),
                ...input,
                heroImageUrl: null,
                isActive: true,
                createdAt: now,
                updatedAt: now,
            },
            select: collectionSelect,
        });
    }

    update(
        collectionId: string,
        data: {
            name?: string;
            slug?: string;
            description?: string | null;
            isPublic?: boolean;
            heroImageUrl?: string | null;
        },
    ): Promise<CollectionRow> {
        return this.prisma.artistCollection.update({
            where: { id: collectionId },
            data: { ...data, updatedAt: new Date() },
            select: collectionSelect,
        });
    }

    /**
     * Soft delete. The row stays: drops, claims, content bundles, evolution
     * and royalty rules all hold foreign keys to it, and a buyer's
     * collection-progress history must keep resolving. Taken off the
     * storefront (`isPublic`, `isActive` false) in the same write.
     *
     * Guarded on `archivedAt: null` so a double press archives once.
     */
    async archive(collectionId: string): Promise<number> {
        const now = new Date();
        const result = await this.prisma.artistCollection.updateMany({
            where: { id: collectionId, archivedAt: null },
            data: { archivedAt: now, isActive: false, isPublic: false, updatedAt: now },
        });
        return result.count;
    }

    /** Rewrites positions 0…n-1 in the given order, in one transaction. */
    async reorder(artistId: string, orderedIds: string[]): Promise<void> {
        const now = new Date();
        await this.prisma.$transaction(
            orderedIds.map((id, position) =>
                this.prisma.artistCollection.updateMany({
                    where: { id, artistId, archivedAt: null },
                    data: { position, updatedAt: now },
                }),
            ),
        );
    }

    // ── Monitoring (every artist) ───────────────────────────────────────────

    async adminList(
        query: AdminListCollectionsQuery,
        liveDropCollectionIds: () => Promise<string[]>,
    ): Promise<{ total: number; items: AdminCollectionRow[] }> {
        const where: Prisma.ArtistCollectionWhereInput = {
            ...archivedFilter(query.status),
            ...(query.artistId ? { artistId: query.artistId } : {}),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.isPublic !== undefined ? { isPublic: query.isPublic } : {}),
            ...(query.q
                ? {
                    OR: [
                        { name: { contains: query.q, mode: 'insensitive' } },
                        { slug: { contains: query.q.toLowerCase() } },
                    ],
                }
                : {}),
            ...(query.createdFrom || query.createdTo
                ? {
                    createdAt: {
                        ...(query.createdFrom ? { gte: query.createdFrom } : {}),
                        ...(query.createdTo ? { lt: query.createdTo } : {}),
                    },
                }
                : {}),
        };
        if (query.empty !== undefined) {
            const withLive = await liveDropCollectionIds();
            where.id = query.empty ? { notIn: withLive } : { in: withLive };
        }

        const orderBy: Prisma.ArtistCollectionOrderByWithRelationInput =
            query.sort === 'oldest' ? { createdAt: 'asc' }
                : query.sort === 'updated' ? { updatedAt: 'desc' }
                    : query.sort === 'name' ? { name: 'asc' }
                        : { createdAt: 'desc' };

        const [total, items] = await Promise.all([
            this.prisma.artistCollection.count({ where }),
            this.prisma.artistCollection.findMany({
                where,
                orderBy: [orderBy, { id: 'asc' }],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
                select: adminSelect,
            }),
        ]);
        return { total, items };
    }

    adminFind(collectionId: string): Promise<AdminCollectionRow | null> {
        return this.prisma.artistCollection.findUnique({ where: { id: collectionId }, select: adminSelect });
    }

    dropsOf(collectionId: string) {
        return this.prisma.drop.findMany({
            where: { collectionId },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: { id: true, name: true, status: true, archivedAt: true, createdAt: true },
        });
    }

    /** Ids of collections holding at least one live drop. */
    async collectionIdsWithLiveDrops(): Promise<string[]> {
        const rows = await this.prisma.drop.groupBy({
            by: ['collectionId'],
            where: { collectionId: { not: null }, archivedAt: null },
        });
        return rows.map((row) => row.collectionId as string);
    }

    async summary(since: Date) {
        const [total, live, isPublic, recent, perArtist] = await Promise.all([
            this.prisma.artistCollection.count(),
            this.prisma.artistCollection.count({ where: { archivedAt: null } }),
            this.prisma.artistCollection.count({ where: { archivedAt: null, isPublic: true } }),
            this.prisma.artistCollection.count({ where: { createdAt: { gte: since } } }),
            this.prisma.artistCollection.groupBy({
                by: ['artistId'],
                where: { archivedAt: null },
                _count: { _all: true },
            }),
        ]);
        return { total, live, isPublic, recent, perArtist };
    }

    artistNames(artistIds: string[]) {
        return this.prisma.artist.findMany({
            where: { id: { in: artistIds } },
            select: { id: true, name: true },
        });
    }

    /** Live collections that have no live drop. */
    async countEmptyLive(withLiveDrops: string[]): Promise<number> {
        return this.prisma.artistCollection.count({
            where: { archivedAt: null, id: { notIn: withLiveDrops } },
        });
    }
}

function archivedFilter(status: 'live' | 'archived' | 'all'): Prisma.ArtistCollectionWhereInput {
    if (status === 'live') return { archivedAt: null };
    if (status === 'archived') return { archivedAt: { not: null } };
    return {};
}
