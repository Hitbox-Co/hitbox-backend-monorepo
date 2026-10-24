import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import { ARTIST_GENRES, resolveGenre } from '../../self/constants/artist-self.constant';
import type { IArtistAuditRecorder } from '../../domain/interfaces/audit-recorder.port';
import {
    ARTIST_ADMIN_AUDIT_EVENTS,
    ARTIST_ADMIN_ERROR_CODES,
    ARTIST_ADMIN_EVENTS,
} from '../constants/artist-admin.constant';
import type { ArtistStateAction } from '../constants/artist-admin.constant';
import type { IArtistInsights } from '../domain/artist-insights.port';
import type {
    ArtistDirectorySummary,
    ArtistStateActionDto,
    ArtistStatsQuery,
    ArtistSummaryQuery,
    StaffArtistProfile,
    StaffArtistStats,
    StaffUpdateArtistDto,
} from '../dto/artist-admin.dto';
import type {
    ArtistAdminRepository,
    ArtistStaffChanges,
    ArtistStateGuard,
    StaffArtistRow,
} from '../repository/artist-admin.repository';

/** Who is acting — from the permission check that let them in. */
export interface StaffActor {
    userId: string;
    /** The role whose grant passed, for the audit row. */
    roleName?: string | null;
}

/** What the caller may see beyond the record itself. */
export interface StaffViewer {
    canSeeMoney: boolean;
}

interface ArtistAdminServiceDeps {
    artists: ArtistAdminRepository;
    audit: IArtistAuditRecorder;
    insights?: IArtistInsights | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    /** Injectable clock, for "new this month" in tests. */
    now?: () => Date;
}

/**
 * Each state action: what the row must look like for it to make sense, and
 * what it sets. The precondition doubles as the write's guard, so a change
 * that races another one is refused rather than applied twice.
 */
const STATE_ACTIONS: Record<
    ArtistStateAction,
    {
        event: string;
        guard: ArtistStateGuard;
        data: (now: Date) => ArtistStaffChanges;
        unchanged: (row: StaffArtistRow) => boolean;
        unchangedMessage: string;
    }
> = {
    activate: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.ACTIVATE,
        guard: { archived: false, isActive: false },
        data: () => ({ isActive: true }),
        unchanged: (row) => row.isActive,
        unchangedMessage: 'This artist is already active.',
    },
    deactivate: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.DEACTIVATE,
        guard: { archived: false, isActive: true },
        data: () => ({ isActive: false }),
        unchanged: (row) => !row.isActive,
        unchangedMessage: 'This artist is already inactive.',
    },
    archive: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.ARCHIVE,
        guard: { archived: false },
        data: (now) => ({ archivedAt: now }),
        unchanged: () => false,
        unchangedMessage: '',
    },
    restore: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.RESTORE,
        guard: { archived: true },
        data: () => ({ archivedAt: null }),
        unchanged: () => false,
        unchangedMessage: '',
    },
    publish: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.PUBLISH,
        guard: { archived: false, isActive: true, isPublic: false },
        data: () => ({ isPublic: true }),
        unchanged: (row) => row.isPublic,
        unchangedMessage: 'This artist is already public.',
    },
    unlist: {
        event: ARTIST_ADMIN_AUDIT_EVENTS.UNLIST,
        guard: { archived: false, isPublic: true },
        data: () => ({ isPublic: false }),
        unchanged: (row) => !row.isPublic,
        unchangedMessage: 'This artist is already unlisted.',
    },
};

/**
 * HitBox staff administering artists: the full profile, stats, the directory
 * summary, edits and state changes. Every change is audited
 * (`artist.profile.*`) and announced on the bus.
 *
 * Figures that live in other modules' tables — sales, royalties, payouts, tax,
 * claims, followers over time — come through `IArtistInsights`, which the
 * reporting module implements. Money is only asked for when the caller may see
 * it.
 */
export class ArtistAdminService {
    constructor(private readonly deps: ArtistAdminServiceDeps) { }

    async profile(artistId: string, viewer: StaffViewer): Promise<StaffArtistProfile> {
        const row = await this.requireArtist(artistId);
        const status = this.deps.insights
            ? await this.deps.insights.accountStatus({ artistId, includeMoney: viewer.canSeeMoney })
            : null;
        return toProfile(row, status);
    }

    async stats(artistId: string, query: ArtistStatsQuery, viewer: StaffViewer): Promise<StaffArtistStats> {
        const insights = this.requireInsights();
        await this.requireArtist(artistId);
        const stats = await insights.stats({
            artistId,
            window: { period: query.period, from: query.from, to: query.to },
            includeMoney: viewer.canSeeMoney,
            topDrops: query.topDrops,
        });
        return { artistId, moneyVisible: viewer.canSeeMoney, ...stats };
    }

    async summary(query: ArtistSummaryQuery, viewer: StaffViewer): Promise<ArtistDirectorySummary> {
        const now = this.deps.now?.() ?? new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

        const [counts, ranks] = await Promise.all([
            this.deps.artists.counts({ organizationId: query.organizationId, monthStart }),
            this.deps.insights
                ? this.deps.insights.topArtistsBySales({
                    limit: query.top,
                    includeMoney: viewer.canSeeMoney,
                    organizationId: query.organizationId,
                })
                : Promise.resolve(null),
        ]);

        let topBySales: ArtistDirectorySummary['topBySales'] = null;
        if (ranks) {
            const cards = new Map(
                (await this.deps.artists.findCards(ranks.map((r) => r.artistId))).map((c) => [c.id, c]),
            );
            topBySales = ranks.flatMap((rank) => {
                const card = cards.get(rank.artistId);
                return card
                    ? [{ ...rank, name: card.name, slug: card.slug, avatarUrl: card.avatarUrl }]
                    : [];
            });
        }

        return { ...counts, moneyVisible: viewer.canSeeMoney, topBySales };
    }

    async update(
        artistId: string,
        dto: StaffUpdateArtistDto,
        actor: StaffActor,
        viewer: StaffViewer,
    ): Promise<StaffArtistProfile> {
        const before = await this.requireArtist(artistId);
        if (before.archivedAt) {
            throw AppError.conflict(
                'This artist is archived. Restore them before editing.',
                ARTIST_ADMIN_ERROR_CODES.ARCHIVED,
            );
        }

        const changes: ArtistStaffChanges = {};
        if (dto.name !== undefined && dto.name !== before.name) changes.name = dto.name;
        if (dto.bio !== undefined && dto.bio !== before.bio) changes.bio = dto.bio;
        if (dto.avatarUrl === null && before.avatarUrl !== null) changes.avatarUrl = null;
        if (dto.coverUrl === null && before.coverUrl !== null) changes.coverUrl = null;
        if (dto.genre !== undefined) {
            const genre = dto.genre === null ? null : resolveGenre(dto.genre);
            if (genre === null && dto.genre !== null) {
                throw AppError.badRequest(
                    `"${dto.genre}" is not a genre on the list. GET /artist/genres lists them.`,
                    ARTIST_ADMIN_ERROR_CODES.GENRE_INVALID,
                    { allowed: ARTIST_GENRES.map((g) => g.code) },
                );
            }
            if (genre !== before.genre) changes.genre = genre;
        }
        if (dto.slug !== undefined && dto.slug !== before.slug) {
            if (await this.deps.artists.slugTaken(dto.slug, artistId)) {
                throw slugTaken(dto.slug);
            }
            changes.slug = dto.slug;
        }

        // Attesting twice keeps the first attestation: who checked, and when,
        // is the evidence — a second click must not overwrite it.
        let compliance: 'attest' | 'revoke' | null = null;
        if (dto.complianceAttested === true && before.complianceAttestedAt === null) {
            compliance = 'attest';
            changes.complianceAttestedAt = this.deps.now?.() ?? new Date();
            changes.complianceAttestedBy = actor.userId;
        } else if (dto.complianceAttested === false && before.complianceAttestedAt !== null) {
            compliance = 'revoke';
            changes.complianceAttestedAt = null;
            changes.complianceAttestedBy = null;
        }

        // Nothing differs: answer with the record, write nothing, audit nothing.
        if (Object.keys(changes).length === 0) return this.profile(artistId, viewer);

        let after: StaffArtistRow | null;
        try {
            after = await this.deps.artists.updateGuarded(artistId, { archived: false }, changes);
        } catch (error) {
            // The pre-check is for the message; the unique index is the authority.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw slugTaken(dto.slug ?? '');
            }
            throw error;
        }
        if (!after) throw changed();

        const fields = Object.keys(changes).filter(
            (key) => key !== 'complianceAttestedAt' && key !== 'complianceAttestedBy',
        );
        const correlationId = randomUUID();
        if (fields.length > 0) {
            await this.audit(ARTIST_ADMIN_AUDIT_EVENTS.UPDATE, actor, before, after, correlationId, {
                fields,
                ...(dto.reason ? { reason: dto.reason } : {}),
            });
        }
        if (compliance) {
            await this.audit(
                compliance === 'attest'
                    ? ARTIST_ADMIN_AUDIT_EVENTS.COMPLIANCE_ATTEST
                    : ARTIST_ADMIN_AUDIT_EVENTS.COMPLIANCE_REVOKE,
                actor, before, after, correlationId,
                dto.reason ? { reason: dto.reason } : {},
            );
        }
        await this.deps.eventBus?.publish(ARTIST_ADMIN_EVENTS.PROFILE_UPDATED, {
            artistId,
            fields: compliance ? [...fields, 'compliance'] : fields,
            by: 'staff',
        });
        return this.profile(artistId, viewer);
    }

    async changeState(
        artistId: string,
        action: ArtistStateAction,
        dto: ArtistStateActionDto,
        actor: StaffActor,
        viewer: StaffViewer,
    ): Promise<StaffArtistProfile> {
        const spec = STATE_ACTIONS[action];
        const before = await this.requireArtist(artistId);

        if (action === 'restore') {
            if (!before.archivedAt) {
                throw AppError.conflict('This artist is not archived.', ARTIST_ADMIN_ERROR_CODES.NOT_ARCHIVED);
            }
        } else if (before.archivedAt) {
            throw AppError.conflict(
                'This artist is archived. Restore them first.',
                ARTIST_ADMIN_ERROR_CODES.ARCHIVED,
            );
        }
        if (spec.unchanged(before)) {
            throw AppError.conflict(spec.unchangedMessage, ARTIST_ADMIN_ERROR_CODES.STATE_UNCHANGED);
        }
        if (action === 'publish' && !before.isActive) {
            throw AppError.conflict(
                'An inactive artist cannot be made public. Activate them first.',
                ARTIST_ADMIN_ERROR_CODES.INACTIVE,
            );
        }

        const now = this.deps.now?.() ?? new Date();
        const after = await this.deps.artists.updateGuarded(artistId, spec.guard, spec.data(now));
        if (!after) throw changed();

        await this.audit(spec.event, actor, before, after, randomUUID(), {
            action,
            ...(dto.reason ? { reason: dto.reason } : {}),
        });
        await this.deps.eventBus?.publish(ARTIST_ADMIN_EVENTS.STATUS_CHANGED, {
            artistId,
            action,
            isActive: after.isActive,
            isPublic: after.isPublic,
            archivedAt: after.archivedAt?.toISOString() ?? null,
        });
        return this.profile(artistId, viewer);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireArtist(artistId: string): Promise<StaffArtistRow> {
        const row = await this.deps.artists.findById(artistId);
        if (!row) throw AppError.notFound('Artist not found', ARTIST_ADMIN_ERROR_CODES.NOT_FOUND);
        return row;
    }

    private requireInsights(): IArtistInsights {
        if (!this.deps.insights) {
            // 400, not 503: a 5xx AppError is rendered as an opaque 500.
            throw AppError.badRequest(
                'Artist stats are not available on this server.',
                ARTIST_ADMIN_ERROR_CODES.STATS_UNAVAILABLE,
            );
        }
        return this.deps.insights;
    }

    private async audit(
        eventType: string,
        actor: StaffActor,
        before: StaffArtistRow,
        after: StaffArtistRow,
        correlationId: string,
        metadata: Record<string, string | string[]>,
    ): Promise<void> {
        await this.deps.audit.record({
            eventType,
            actor: { type: 'HITBOX_ADMIN', id: actor.userId, roleSnapshot: actor.roleName ?? null },
            result: 'SUCCESS',
            organizationId: after.organizationId,
            resource: { type: 'Artist', id: after.id },
            beforeState: snapshot(before),
            afterState: snapshot(after),
            correlationId,
            metadata,
        });
    }
}

function snapshot(row: StaffArtistRow) {
    return {
        name: row.name,
        slug: row.slug,
        bio: row.bio,
        genre: row.genre,
        avatarUrl: row.avatarUrl,
        coverUrl: row.coverUrl,
        isActive: row.isActive,
        isPublic: row.isPublic,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        complianceAttestedAt: row.complianceAttestedAt?.toISOString() ?? null,
        complianceAttestedBy: row.complianceAttestedBy,
    };
}

function slugTaken(slug: string): AppError {
    return AppError.conflict(`The handle "${slug}" is already taken.`, ARTIST_ADMIN_ERROR_CODES.SLUG_TAKEN);
}

function changed(): AppError {
    return AppError.conflict(
        'This artist changed while you were editing. Reload and try again.',
        ARTIST_ADMIN_ERROR_CODES.CHANGED,
    );
}

function toProfile(
    row: StaffArtistRow,
    status: Awaited<ReturnType<IArtistInsights['accountStatus']>> | null,
): StaffArtistProfile {
    return {
        id: row.id,
        publicCode: row.publicCode,
        name: row.name,
        slug: row.slug,
        bio: row.bio,
        genre: row.genre,
        avatarUrl: row.avatarUrl,
        coverUrl: row.coverUrl,
        isPublic: row.isPublic,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        editable: row.isActive && row.archivedAt === null,
        account: row.user
            ? {
                userId: row.user.id,
                email: row.user.email,
                fullName: row.user.fullName,
                isActive: row.user.isActive,
                joinedAt: row.user.createdAt.toISOString(),
            }
            : null,
        invitationId: row.invitationId,
        organization:
            row.organizationId && row.organization
                ? { id: row.organizationId, name: row.organization.name, type: row.organization.type }
                : null,
        brandLinks: row.artistBrandLinks.map((link) => ({
            id: link.id,
            organizationId: link.organizationId,
            organizationName: link.organization.name,
            linkType: link.linkType,
            startDate: link.startDate.toISOString(),
            endDate: link.endDate?.toISOString() ?? null,
            isActive: link.isActive,
        })),
        compliance: {
            attested: row.complianceAttestedAt !== null,
            attestedAt: row.complianceAttestedAt?.toISOString() ?? null,
            attestedById: row.complianceAttestedBy,
        },
        payouts: status?.payouts ?? null,
        tax: status?.tax ?? null,
        counts: {
            drops: row._count.drops,
            collections: row._count.artistCollections,
            followers: row._count.follows,
            claims: row._count.skuClaims,
        },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
