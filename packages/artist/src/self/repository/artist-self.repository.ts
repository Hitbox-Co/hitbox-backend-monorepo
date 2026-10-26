import type { Prisma, PrismaClient } from '@hitbox/database';

/**
 * The artist's own full profile.
 *
 * Wider than the directory projection (it includes `bio`, `coverUrl` and the
 * compliance state) because the only reader is the artist themselves.
 * `complianceAttestedBy` — a staff member's user id — is still not selected:
 * the artist sees *that* they were attested and when, not by whom.
 */
const selfSelect = {
    id: true,
    publicCode: true,
    name: true,
    slug: true,
    bio: true,
    genre: true,
    avatarUrl: true,
    coverUrl: true,
    isPublic: true,
    isActive: true,
    archivedAt: true,
    complianceAttestedAt: true,
    organizationId: true,
    organization: { select: { name: true, type: true } },
    createdAt: true,
    updatedAt: true,
    _count: { select: { drops: true, artistCollections: true, follows: true } },
} satisfies Prisma.ArtistSelect;

export type ArtistSelfRow = Prisma.ArtistGetPayload<{ select: typeof selfSelect }>;

/** The only place in the self-service feature that touches Prisma. */
export class ArtistSelfRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** `Artist.userId` is unique — one account backs at most one profile. */
    findByUserId(userId: string): Promise<ArtistSelfRow | null> {
        return this.prisma.artist.findUnique({ where: { userId }, select: selfSelect });
    }

    /** Is this slug used by an artist other than `exceptArtistId`? */
    async slugTaken(slug: string, exceptArtistId: string): Promise<boolean> {
        const row = await this.prisma.artist.findUnique({ where: { slug }, select: { id: true } });
        return row !== null && row.id !== exceptArtistId;
    }

    update(
        artistId: string,
        data: {
            name?: string;
            slug?: string;
            bio?: string | null;
            genre?: string | null;
            isPublic?: boolean;
            avatarUrl?: string | null;
            coverUrl?: string | null;
        },
    ): Promise<ArtistSelfRow> {
        return this.prisma.artist.update({
            where: { id: artistId },
            data: { ...data, updatedAt: new Date() },
            select: selfSelect,
        });
    }
}
