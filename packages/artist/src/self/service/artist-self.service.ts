import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import {
    ARTIST_GENRES,
    ARTIST_SELF_ERROR_CODES,
    ARTIST_SELF_EVENTS,
    resolveGenre,
} from '../constants/artist-self.constant';
import type {
    ArtistImageKind,
    ImageUploadRequestDto,
    SetImageDto,
    UpdateMyProfileDto,
} from '../dto/artist-self.dto';
import type {
    ArtistImageUploadTicket,
    IArtistImageStorage,
} from '../domain/artist-image-storage.interface';
import type { ArtistSelfRepository, ArtistSelfRow } from '../repository/artist-self.repository';

/** The artist's own profile, as `/artist/me` returns it. */
export interface MyArtistProfile {
    id: string;
    publicCode: string | null;
    name: string;
    slug: string;
    bio: string | null;
    genre: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    isPublic: boolean;
    isActive: boolean;
    archivedAt: string | null;
    /** True when the profile may be edited (active and not archived). */
    editable: boolean;
    compliance: { attested: boolean; attestedAt: string | null };
    organization: { id: string; name: string; type: string } | null;
    counts: { drops: number; collections: number; followers: number };
    createdAt: string;
    updatedAt: string;
}

function toProfile(row: ArtistSelfRow): MyArtistProfile {
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
        compliance: {
            attested: row.complianceAttestedAt !== null,
            attestedAt: row.complianceAttestedAt?.toISOString() ?? null,
        },
        organization:
            row.organizationId && row.organization
                ? { id: row.organizationId, name: row.organization.name, type: row.organization.type }
                : null,
        counts: {
            drops: row._count.drops,
            collections: row._count.artistCollections,
            followers: row._count.follows,
        },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

interface ArtistSelfServiceDeps {
    artists: ArtistSelfRepository;
    images?: IArtistImageStorage | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
}

/**
 * An artist managing their own profile.
 *
 * "Which artist?" is never a request parameter: it is always the profile
 * linked to the signed-in account (`Artist.userId`). There is no id an artist
 * could change to reach someone else's record.
 */
export class ArtistSelfService {
    constructor(private readonly deps: ArtistSelfServiceDeps) { }

    genres(): { code: string; label: string }[] {
        return ARTIST_GENRES.map((g) => ({ code: g.code, label: g.label }));
    }

    async get(userId: string): Promise<MyArtistProfile> {
        return toProfile(await this.requireMine(userId));
    }

    async update(userId: string, dto: UpdateMyProfileDto): Promise<MyArtistProfile> {
        const me = await this.requireEditable(userId);

        let genre: string | null | undefined;
        if (dto.genre !== undefined) {
            genre = dto.genre === null ? null : resolveGenre(dto.genre);
            if (genre === null && dto.genre !== null) {
                throw AppError.badRequest(
                    `"${dto.genre}" is not a genre on the list. GET /artist/genres lists them.`,
                    ARTIST_SELF_ERROR_CODES.GENRE_INVALID,
                    { allowed: ARTIST_GENRES.map((g) => g.code) },
                );
            }
        }

        if (dto.slug !== undefined && dto.slug !== me.slug) {
            if (await this.deps.artists.slugTaken(dto.slug, me.id)) {
                throw AppError.conflict(
                    `The handle "${dto.slug}" is already taken.`,
                    ARTIST_SELF_ERROR_CODES.SLUG_TAKEN,
                );
            }
        }

        try {
            const row = await this.deps.artists.update(me.id, {
                ...(dto.name !== undefined && { name: dto.name }),
                ...(dto.slug !== undefined && { slug: dto.slug }),
                ...(dto.bio !== undefined && { bio: dto.bio }),
                ...(genre !== undefined && { genre }),
                ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
            });
            await this.published(row, Object.keys(dto));
            return toProfile(row);
        } catch (error) {
            // The pre-check above is for the message; the unique index is the
            // authority when two artists claim the same handle at once.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw AppError.conflict(
                    `The handle "${dto.slug}" is already taken.`,
                    ARTIST_SELF_ERROR_CODES.SLUG_TAKEN,
                );
            }
            throw error;
        }
    }

    // ── Avatar & cover ──────────────────────────────────────────────────────

    /** Step 1: a presigned URL to PUT the file to. Nothing on the profile changes yet. */
    async createImageUpload(
        userId: string,
        kind: ArtistImageKind,
        dto: ImageUploadRequestDto,
    ): Promise<ArtistImageUploadTicket & { kind: ArtistImageKind }> {
        const images = this.requireImages();
        const me = await this.requireEditable(userId);
        const ticket = await images.createUpload({
            artistId: me.id,
            uploadedById: userId,
            fileName: dto.fileName,
            mimeType: dto.mimeType,
            sizeBytes: dto.sizeBytes,
        });
        return { kind, ...ticket };
    }

    /** Step 3: point the profile at the uploaded file. */
    async setImage(userId: string, kind: ArtistImageKind, dto: SetImageDto): Promise<MyArtistProfile> {
        const images = this.requireImages();
        const me = await this.requireEditable(userId);
        const asset = await images.findAsset(dto.assetId);

        const refuse = (why: string): never => {
            throw AppError.badRequest(
                `That image cannot be used as your ${kind}: ${why}`,
                ARTIST_SELF_ERROR_CODES.IMAGE_INVALID,
                { assetId: dto.assetId },
            );
        };
        if (!asset) refuse('it does not exist.');
        if (asset!.artistId !== me.id) refuse('it was not uploaded to your profile.');
        if (asset!.assetType !== 'PROFILE_IMAGE') refuse('it is not a profile image.');
        if (asset!.archived) refuse('it has been deleted.');
        if (asset!.virusScanStatus === 'INFECTED') refuse('it failed the virus scan.');
        if (asset!.virusScanStatus === 'PENDING') refuse('it is still being scanned — try again shortly.');
        if (!asset!.publicUrl) refuse('it is not stored where profile images are served from.');

        const row = await this.deps.artists.update(
            me.id,
            kind === 'avatar' ? { avatarUrl: asset!.publicUrl } : { coverUrl: asset!.publicUrl },
        );
        await this.published(row, [kind === 'avatar' ? 'avatarUrl' : 'coverUrl']);
        return toProfile(row);
    }

    /** Removes the image from the profile. The stored file is kept (history, audits). */
    async removeImage(userId: string, kind: ArtistImageKind): Promise<MyArtistProfile> {
        const me = await this.requireEditable(userId);
        const row = await this.deps.artists.update(
            me.id,
            kind === 'avatar' ? { avatarUrl: null } : { coverUrl: null },
        );
        await this.published(row, [kind === 'avatar' ? 'avatarUrl' : 'coverUrl']);
        return toProfile(row);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireMine(userId: string): Promise<ArtistSelfRow> {
        const row = await this.deps.artists.findByUserId(userId);
        if (!row) {
            throw AppError.notFound(
                'Your account is not linked to an artist profile. Artist profiles are created ' +
                'when HitBox invites you as an artist.',
                ARTIST_SELF_ERROR_CODES.PROFILE_NOT_FOUND,
            );
        }
        return row;
    }

    private async requireEditable(userId: string): Promise<ArtistSelfRow> {
        const row = await this.requireMine(userId);
        if (row.archivedAt !== null || !row.isActive) {
            throw AppError.conflict(
                'Your artist profile is ' + (row.archivedAt ? 'archived' : 'deactivated') +
                ', so it cannot be edited. Contact HitBox support.',
                ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED,
            );
        }
        return row;
    }

    private requireImages(): IArtistImageStorage {
        if (!this.deps.images) {
            // 400, matching products' MEDIA_UNAVAILABLE: the error handler
            // masks 5xx as a generic 500, and this message is the useful part.
            throw AppError.badRequest(
                'Image uploads are not configured on this server.',
                ARTIST_SELF_ERROR_CODES.IMAGES_UNAVAILABLE,
            );
        }
        return this.deps.images;
    }

    private async published(row: ArtistSelfRow, fields: string[]): Promise<void> {
        await this.deps.eventBus?.publish(ARTIST_SELF_EVENTS.PROFILE_UPDATED, {
            artistId: row.id,
            fields,
        });
    }
}
