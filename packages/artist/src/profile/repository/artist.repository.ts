import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { slugify } from '../domain/artist-role';
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
    invitationId: true,
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

    // ── Provisioning from an invitation ──────────────────────────────────

    findByInvitationId(invitationId: string): Promise<ArtistRow | null> {
        return this.prisma.artist.findUnique({
            where: { invitationId },
            select: artistSelect,
        });
    }

    findByUserId(userId: string): Promise<ArtistRow | null> {
        return this.prisma.artist.findUnique({ where: { userId }, select: artistSelect });
    }

    /**
     * Creates the profile for an invited artist.
     *
     * `userId` is null: the person has no account yet, and may never accept.
     * `isPublic` is false: the profile has no bio, no avatar and an unverified
     * name, so it is not something to publish on the storefront until somebody
     * fills it in. It is `isActive` because a drop can be filed against it
     * immediately — which is the whole point of creating it at invite time.
     *
     * The slug collision retry is here rather than in the service because the
     * unique index is here: a pre-check in the service is stale the moment it
     * returns, and two artists named "Kaze" invited seconds apart is ordinary.
     */
    async createFromInvitation(input: {
        invitationId: string;
        name: string;
        genre: string | null;
        organizationId: string | null;
        userId: string | null;
    }): Promise<ArtistRow> {
        const base = slugify(input.name);
        const now = new Date();

        for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
            // First attempt uses the clean slug; later ones add a short
            // random suffix rather than a counter, which would need another
            // read to know where to start counting.
            const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
            try {
                return await this.prisma.artist.create({
                    data: {
                        id: randomUUID(),
                        invitationId: input.invitationId,
                        name: input.name,
                        slug,
                        genre: input.genre,
                        organizationId: input.organizationId,
                        userId: input.userId,
                        isPublic: false,
                        isActive: true,
                        createdAt: now,
                        updatedAt: now,
                    },
                    select: artistSelect,
                });
            } catch (error) {
                if (isUniqueViolation(error, 'slug') && attempt < SLUG_ATTEMPTS - 1) continue;
                throw error;
            }
        }
        /* c8 ignore next */
        throw new Error(`Could not allocate a unique slug for "${input.name}"`);
    }

    /** Links an invited profile to the account once the person accepts. */
    linkUser(artistId: string, userId: string): Promise<ArtistRow> {
        return this.prisma.artist.update({
            where: { id: artistId },
            data: { userId, updatedAt: new Date() },
            select: artistSelect,
        });
    }
}

const SLUG_ATTEMPTS = 5;

function randomSuffix(): string {
    return randomUUID().slice(0, 6);
}

function isUniqueViolation(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        return false;
    }
    const target = error.meta?.target;
    const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    return names.some((name) => name.includes(field));
}
