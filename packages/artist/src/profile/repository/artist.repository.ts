import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListArtistsQuery } from '../dto/artist.dto';

/**
 * Directory projection.
 *
 * Note what is NOT selected: `bio`, `userId`, `complianceAttestedAt` and
 * `complianceAttestedBy`. This endpoint is gated on `drop:read` so a Drop
 * Manager can fill a picker, and a compliance attestation is not a picker
 * field. Keeping it out of the query rather than dropping it in the mapper
 * means a future edit to the response shape cannot leak it by accident.
 */
const artistSelect = {
    id: true,
    name: true,
    slug: true,
    genre: true,
    avatarUrl: true,
    isPublic: true,
    isActive: true,
    archivedAt: true,
    organizationId: true,
    organization: { select: { name: true } },
    _count: { select: { products: true, artistCollections: true } },
} satisfies Prisma.ArtistSelect;

export type ArtistRow = Prisma.ArtistGetPayload<{ select: typeof artistSelect }>;

/** The only place in this sub-module that touches Prisma. */
export class ArtistRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(query: ListArtistsQuery): Promise<{ total: number; items: ArtistRow[] }> {
        const where: Prisma.ArtistWhereInput = {
            ...(query.includeArchived ? {} : { archivedAt: null }),
            ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
            ...(query.isPublic === undefined ? {} : { isPublic: query.isPublic }),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.search
                ? {
                    OR: [
                        { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                        { slug: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                    ],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.artist.count({ where }),
            this.prisma.artist.findMany({
                where,
                select: artistSelect,
                // Alphabetical — this backs a picker scanned by eye.
                orderBy: { name: 'asc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    findById(id: string): Promise<ArtistRow | null> {
        return this.prisma.artist.findUnique({ where: { id }, select: artistSelect });
    }

    findBySlug(slug: string): Promise<ArtistRow | null> {
        return this.prisma.artist.findUnique({ where: { slug }, select: artistSelect });
    }
}
