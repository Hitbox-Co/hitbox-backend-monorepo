import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';

/**
 * The staff projection — everything about an artist record, for HitBox staff
 * behind `brand-artist-record:read` at global scope.
 *
 * Wider than both the directory (a picker, `drop:read`) and the artist's own
 * view: it carries the linked account, the invitation and who attested
 * compliance. That is why it lives in its own repository rather than widening
 * either of those selects.
 */
const staffSelect = {
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
    invitationId: true,
    complianceAttestedAt: true,
    complianceAttestedBy: true,
    organizationId: true,
    organization: { select: { name: true, type: true } },
    userId: true,
    user: { select: { id: true, email: true, fullName: true, isActive: true, createdAt: true } },
    artistBrandLinks: {
        select: {
            id: true,
            organizationId: true,
            organization: { select: { name: true } },
            linkType: true,
            startDate: true,
            endDate: true,
            isActive: true,
        },
        orderBy: { startDate: 'desc' },
    },
    createdAt: true,
    updatedAt: true,
    _count: { select: { drops: true, artistCollections: true, follows: true, skuClaims: true } },
} satisfies Prisma.ArtistSelect;

export type StaffArtistRow = Prisma.ArtistGetPayload<{ select: typeof staffSelect }>;

/** What a guarded state write may require of the row it changes. */
export interface ArtistStateGuard {
    isActive?: boolean;
    isPublic?: boolean;
    archived?: boolean;
}

export interface ArtistStaffChanges {
    name?: string;
    slug?: string;
    bio?: string | null;
    genre?: string | null;
    avatarUrl?: null;
    coverUrl?: null;
    complianceAttestedAt?: Date | null;
    complianceAttestedBy?: string | null;
    isActive?: boolean;
    isPublic?: boolean;
    archivedAt?: Date | null;
}

export interface ArtistCountsRow {
    total: number;
    active: number;
    inactive: number;
    public: number;
    unlisted: number;
    archived: number;
    newThisMonth: number;
    withoutAvatar: number;
    withoutBio: number;
    withoutAccount: number;
    withoutCompliance: number;
}

/** The only place in the staff feature that touches Prisma. */
export class ArtistAdminRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<StaffArtistRow | null> {
        return this.prisma.artist.findUnique({ where: { id }, select: staffSelect });
    }

    async slugTaken(slug: string, exceptArtistId: string): Promise<boolean> {
        const row = await this.prisma.artist.findUnique({ where: { slug }, select: { id: true } });
        return row !== null && row.id !== exceptArtistId;
    }

    /**
     * Writes `data` only while the row still matches `guard` — read-then-write
     * without the race. Returns null when the guard no longer holds (someone
     * changed the artist in between), and the caller answers 409.
     */
    async updateGuarded(
        id: string,
        guard: ArtistStateGuard,
        data: ArtistStaffChanges,
    ): Promise<StaffArtistRow | null> {
        const where: Prisma.ArtistWhereInput = {
            id,
            ...(guard.isActive === undefined ? {} : { isActive: guard.isActive }),
            ...(guard.isPublic === undefined ? {} : { isPublic: guard.isPublic }),
            ...(guard.archived === undefined
                ? {}
                : { archivedAt: guard.archived ? { not: null } : null }),
        };
        const { count } = await this.prisma.artist.updateMany({
            where,
            data: { ...data, updatedAt: new Date() },
        });
        return count === 1 ? this.findById(id) : null;
    }

    /** Every directory-summary count in one round trip. */
    async counts(input: { organizationId?: string | undefined; monthStart: Date }): Promise<ArtistCountsRow> {
        const org = input.organizationId
            ? Prisma.sql`AND a."organizationId" = ${input.organizationId}::uuid`
            : Prisma.empty;
        const rows = await this.prisma.$queryRaw<Record<keyof ArtistCountsRow, bigint>[]>(Prisma.sql`
            SELECT
                count(*) FILTER (WHERE a."archivedAt" IS NULL)                                         AS "total",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."isActive")                        AS "active",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND NOT a."isActive")                    AS "inactive",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."isPublic")                        AS "public",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND NOT a."isPublic")                    AS "unlisted",
                count(*) FILTER (WHERE a."archivedAt" IS NOT NULL)                                     AS "archived",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."createdAt" >= ${input.monthStart}) AS "newThisMonth",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."avatarUrl" IS NULL)               AS "withoutAvatar",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND COALESCE(btrim(a.bio), '') = '')     AS "withoutBio",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."userId" IS NULL)                  AS "withoutAccount",
                count(*) FILTER (WHERE a."archivedAt" IS NULL AND a."complianceAttestedAt" IS NULL)    AS "withoutCompliance"
            FROM "Artist" a
            WHERE true ${org}
        `);
        const row = rows[0];
        const out = {} as ArtistCountsRow;
        for (const key of COUNT_KEYS) out[key] = Number(row?.[key] ?? 0);
        return out;
    }

    /** Names for the "top artists" tiles. */
    findCards(ids: string[]): Promise<{ id: string; name: string; slug: string; avatarUrl: string | null }[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.prisma.artist.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, slug: true, avatarUrl: true },
        });
    }
}

const COUNT_KEYS: (keyof ArtistCountsRow)[] = [
    'total', 'active', 'inactive', 'public', 'unlisted', 'archived', 'newThisMonth',
    'withoutAvatar', 'withoutBio', 'withoutAccount', 'withoutCompliance',
];
