import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import {
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
    MAX_LIVE_COLLECTIONS_PER_ARTIST,
} from '../constants/artist-collection.constant';
import {
    ARTIST_SELF_ERROR_CODES,
    ARTIST_SLUG_MAX,
} from '../../self/constants/artist-self.constant';
import type {
    AdminCollectionDetailView,
    AdminCollectionView,
    AdminListCollectionsQuery,
    CollectionSummaryView,
    CollectionView,
    CreateCollectionDto,
    ListMyCollectionsQuery,
    MyCollectionView,
    ReorderCollectionsDto,
    UpdateCollectionDto,
} from '../dto/artist-collection.dto';
import type {
    AdminCollectionRow,
    ArtistCollectionRepository,
    CollectionRow,
} from '../repository/artist-collection.repository';
import type { ArtistSelfRepository, ArtistSelfRow } from '../../self/repository/artist-self.repository';
import type {
    ArtistImageUploadTicket,
    IArtistImageStorage,
} from '../../self/domain/artist-image-storage.interface';
import type { ImageUploadRequestDto, SetImageDto } from '../../self/dto/artist-self.dto';
import { slugify } from '../../profile/domain/artist-role';

export interface ArtistCollectionServiceDeps {
    collections: ArtistCollectionRepository;
    artists: ArtistSelfRepository;
    images?: IArtistImageStorage | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    now?: () => Date;
}

function toView(row: CollectionRow, liveDrops: number): CollectionView {
    return {
        id: row.id,
        publicCode: row.publicCode,
        name: row.name,
        slug: row.slug,
        description: row.description,
        heroImageUrl: row.heroImageUrl,
        position: row.position,
        isPublic: row.isPublic,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        status: row.archivedAt ? 'ARCHIVED' : 'LIVE',
        counts: { drops: row._count.drops, liveDrops },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function toMine(row: CollectionRow, liveDrops: number): MyCollectionView {
    const archived = row.archivedAt !== null;
    const blocked = archived ? 'ARCHIVED' : liveDrops > 0 ? 'HAS_DROPS' : null;
    return {
        ...toView(row, liveDrops),
        actions: { canEdit: !archived, canArchive: blocked === null, archiveBlockedReason: blocked },
    };
}

function toAdmin(row: AdminCollectionRow, liveDrops: number): AdminCollectionView {
    return {
        ...toView(row, liveDrops),
        artist: {
            id: row.artist.id,
            name: row.artist.name,
            slug: row.artist.slug,
            isActive: row.artist.isActive,
            archived: row.artist.archivedAt !== null,
        },
        organization: row.organization ? { id: row.organization.id, name: row.organization.name } : null,
    };
}

/**
 * Artist collections: an artist curating their own series of drops, and
 * HitBox monitoring every artist's.
 *
 * "Which artist?" is never a request parameter on the artist side — it is the
 * profile linked to the signed-in account, exactly as on `/artist/me`. A
 * collection id belonging to another artist is simply not found.
 *
 * Collections are curated, not stocked: an artist creates and arranges them,
 * but which drops sit in a collection is set on the drop (by the drop's
 * managers), so there is no "add drop" route here. That is also why archiving
 * refuses while live drops remain — the artist cannot move them, and an
 * archived collection still holding on-sale drops would hide them from the
 * artist's page while every drop page still names it.
 */
export class ArtistCollectionService {
    constructor(private readonly deps: ArtistCollectionServiceDeps) { }

    // ── The artist's own ────────────────────────────────────────────────────

    async listMine(userId: string, query: ListMyCollectionsQuery): Promise<MyCollectionView[]> {
        const me = await this.requireArtist(userId);
        const rows = await this.deps.collections.listForArtist(me.id, query.status);
        const live = await this.deps.collections.liveDropCounts(rows.map((r) => r.id));
        return rows.map((row) => toMine(row, live.get(row.id) ?? 0));
    }

    async getMine(userId: string, collectionId: string): Promise<MyCollectionView> {
        const me = await this.requireArtist(userId);
        return this.viewMine(await this.requireCollection(me.id, collectionId));
    }

    async create(userId: string, dto: CreateCollectionDto): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);

        if ((await this.deps.collections.countLive(me.id)) >= MAX_LIVE_COLLECTIONS_PER_ARTIST) {
            throw AppError.conflict(
                `You already have ${MAX_LIVE_COLLECTIONS_PER_ARTIST} collections. Archive one before creating another.`,
                ARTIST_COLLECTION_ERROR_CODES.LIMIT_REACHED,
                { max: MAX_LIVE_COLLECTIONS_PER_ARTIST },
            );
        }
        await this.assertNameFree(me.id, dto.name);

        const slug = dto.slug ?? (await this.freeSlug(me.slug, dto.name));
        if (dto.slug && (await this.deps.collections.slugTaken(dto.slug))) this.slugTaken(dto.slug);

        // Appended at the end of the artist's list. Two creates racing can
        // share a position; the order is still stable (ties break on
        // createdAt) and the next reorder renumbers it.
        const position = await this.deps.collections.nextPosition(me.id);
        const row = await this.withSlugGuard(slug, () =>
            this.deps.collections.create({
                artistId: me.id,
                // Server-derived, never from the body: the collection belongs to
                // whatever organization the artist belongs to.
                organizationId: me.organizationId,
                name: dto.name,
                slug,
                description: dto.description ?? null,
                isPublic: dto.isPublic,
                position,
            }),
        );

        await this.publish(ARTIST_COLLECTION_EVENTS.CREATED, row, me.id);
        this.deps.logger.info({ artistId: me.id, collectionId: row.id }, 'artist collection created');
        return toMine(row, 0);
    }

    async update(userId: string, collectionId: string, dto: UpdateCollectionDto): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);

        if (dto.name !== undefined && dto.name.toLowerCase() !== current.name.toLowerCase()) {
            await this.assertNameFree(me.id, dto.name, current.id);
        }
        if (dto.slug !== undefined && dto.slug !== current.slug && (await this.deps.collections.slugTaken(dto.slug, current.id))) {
            this.slugTaken(dto.slug);
        }

        const row = await this.withSlugGuard(dto.slug ?? current.slug, () =>
            this.deps.collections.update(current.id, {
                ...(dto.name !== undefined && { name: dto.name }),
                ...(dto.slug !== undefined && { slug: dto.slug }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
            }),
        );
        await this.publish(ARTIST_COLLECTION_EVENTS.UPDATED, row, me.id, Object.keys(dto));
        return this.viewMine(row);
    }

    /** DELETE — a soft archive. See the repository for why the row stays. */
    async archive(userId: string, collectionId: string): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);

        const liveDrops = (await this.deps.collections.liveDropCounts([current.id])).get(current.id) ?? 0;
        if (liveDrops > 0) {
            throw AppError.conflict(
                `This collection still holds ${liveDrops} drop${liveDrops === 1 ? '' : 's'}. ` +
                'Drops have to be moved to another collection or retired before it can be deleted — ' +
                'ask your brand team or HitBox to do that.',
                ARTIST_COLLECTION_ERROR_CODES.HAS_DROPS,
                { liveDrops },
            );
        }

        if ((await this.deps.collections.archive(current.id)) === 0) {
            throw AppError.conflict('This collection is already deleted.', ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
        }
        // Close the gap it leaves in the live order.
        const remaining = (await this.deps.collections.listForArtist(me.id, 'live')).map((r) => r.id);
        if (remaining.length > 0) await this.deps.collections.reorder(me.id, remaining);

        const row = (await this.deps.collections.findForArtist(me.id, current.id))!;
        await this.publish(ARTIST_COLLECTION_EVENTS.ARCHIVED, row, me.id);
        this.deps.logger.info({ artistId: me.id, collectionId: row.id }, 'artist collection archived');
        return toMine(row, 0);
    }

    /**
     * PUT /artist/collections/order — the whole live list, in its new order.
     * The whole list rather than one item's new position, so two tabs racing
     * can't leave two collections at the same position.
     */
    async reorder(userId: string, dto: ReorderCollectionsDto): Promise<MyCollectionView[]> {
        const me = await this.requireEditableArtist(userId);
        const live = (await this.deps.collections.listForArtist(me.id, 'live')).map((r) => r.id);

        const given = new Set(dto.collectionIds);
        const missing = live.filter((id) => !given.has(id));
        const unknown = dto.collectionIds.filter((id) => !live.includes(id));
        if (missing.length > 0 || unknown.length > 0) {
            throw AppError.badRequest(
                'Send every live collection exactly once, in the new order.',
                ARTIST_COLLECTION_ERROR_CODES.ORDER_MISMATCH,
                { missing, unknown },
            );
        }

        await this.deps.collections.reorder(me.id, dto.collectionIds);
        await this.deps.eventBus?.publish(ARTIST_COLLECTION_EVENTS.REORDERED, {
            artistId: me.id,
            collectionIds: dto.collectionIds,
        });
        return this.listMine(userId, { status: 'live' });
    }

    // ── Hero image (same storage and rules as the profile's cover) ──────────

    async createHeroUpload(
        userId: string,
        collectionId: string,
        dto: ImageUploadRequestDto,
    ): Promise<ArtistImageUploadTicket> {
        const images = this.requireImages();
        const me = await this.requireEditableArtist(userId);
        await this.requireLive(me.id, collectionId);
        return images.createUpload({
            artistId: me.id,
            uploadedById: userId,
            fileName: dto.fileName,
            mimeType: dto.mimeType,
            sizeBytes: dto.sizeBytes,
        });
    }

    async setHero(userId: string, collectionId: string, dto: SetImageDto): Promise<MyCollectionView> {
        const images = this.requireImages();
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);
        const asset = await images.findAsset(dto.assetId);

        const refuse = (why: string): never => {
            throw AppError.badRequest(
                `That image cannot be used for this collection: ${why}`,
                ARTIST_SELF_ERROR_CODES.IMAGE_INVALID,
                { assetId: dto.assetId },
            );
        };
        if (!asset) return refuse('it does not exist.');
        if (asset.artistId !== me.id) refuse('it was not uploaded by you.');
        if (asset.assetType !== 'PROFILE_IMAGE') refuse('it is not an image upload.');
        if (asset.archived) refuse('it has been deleted.');
        if (asset.virusScanStatus === 'INFECTED') refuse('it failed the virus scan.');
        if (asset.virusScanStatus === 'PENDING') refuse('it is still being scanned — try again shortly.');
        if (!asset.publicUrl) refuse('it is not stored where public images are served from.');

        const row = await this.deps.collections.update(current.id, { heroImageUrl: asset.publicUrl });
        await this.publish(ARTIST_COLLECTION_EVENTS.UPDATED, row, me.id, ['heroImageUrl']);
        return this.viewMine(row);
    }

    async removeHero(userId: string, collectionId: string): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);
        const row = await this.deps.collections.update(current.id, { heroImageUrl: null });
        await this.publish(ARTIST_COLLECTION_EVENTS.UPDATED, row, me.id, ['heroImageUrl']);
        return this.viewMine(row);
    }

    // ── Monitoring (HitBox) ─────────────────────────────────────────────────

    async adminList(query: AdminListCollectionsQuery): Promise<{
        page: number; limit: number; total: number; items: AdminCollectionView[];
    }> {
        const { total, items } = await this.deps.collections.adminList(
            query,
            () => this.deps.collections.collectionIdsWithLiveDrops(),
        );
        const live = await this.deps.collections.liveDropCounts(items.map((r) => r.id));
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => toAdmin(row, live.get(row.id) ?? 0)),
        };
    }

    async adminGet(collectionId: string): Promise<AdminCollectionDetailView> {
        const row = await this.deps.collections.adminFind(collectionId);
        if (!row) {
            throw AppError.notFound('Collection not found.', ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        }
        const [live, drops] = await Promise.all([
            this.deps.collections.liveDropCounts([row.id]),
            this.deps.collections.dropsOf(row.id),
        ]);
        return {
            ...toAdmin(row, live.get(row.id) ?? 0),
            drops: drops.map((d) => ({
                id: d.id,
                name: d.name,
                status: d.status,
                archivedAt: d.archivedAt?.toISOString() ?? null,
                createdAt: d.createdAt.toISOString(),
            })),
        };
    }

    async adminSummary(): Promise<CollectionSummaryView> {
        const now = this.deps.now?.() ?? new Date();
        const since = new Date(now.getTime() - 30 * 86_400_000);
        const [stats, withLive] = await Promise.all([
            this.deps.collections.summary(since),
            this.deps.collections.collectionIdsWithLiveDrops(),
        ]);
        const empty = await this.deps.collections.countEmptyLive(withLive);
        const top = [...stats.perArtist]
            .sort((a, b) => b._count._all - a._count._all)
            .slice(0, 10);
        const names = new Map(
            (await this.deps.collections.artistNames(top.map((t) => t.artistId))).map((a) => [a.id, a.name]),
        );
        return {
            total: stats.total,
            live: stats.live,
            archived: stats.total - stats.live,
            public: stats.isPublic,
            private: stats.live - stats.isPublic,
            empty,
            createdLast30Days: stats.recent,
            artistsWithCollections: stats.perArtist.length,
            topArtists: top.map((t) => ({
                artistId: t.artistId,
                name: names.get(t.artistId) ?? '',
                liveCollections: t._count._all,
            })),
        };
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async viewMine(row: CollectionRow): Promise<MyCollectionView> {
        const live = (await this.deps.collections.liveDropCounts([row.id])).get(row.id) ?? 0;
        return toMine(row, live);
    }

    private async requireArtist(userId: string): Promise<ArtistSelfRow> {
        const row = await this.deps.artists.findByUserId(userId);
        if (!row) {
            throw AppError.notFound(
                'Your account is not linked to an artist profile.',
                ARTIST_SELF_ERROR_CODES.PROFILE_NOT_FOUND,
            );
        }
        return row;
    }

    /** Same lock as the profile: an archived or deactivated artist can only read. */
    private async requireEditableArtist(userId: string): Promise<ArtistSelfRow> {
        const row = await this.requireArtist(userId);
        if (row.archivedAt !== null || !row.isActive) {
            throw AppError.conflict(
                'Your artist profile is ' + (row.archivedAt ? 'archived' : 'deactivated') +
                ', so its collections cannot be changed. Contact HitBox support.',
                ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED,
            );
        }
        return row;
    }

    private async requireCollection(artistId: string, collectionId: string): Promise<CollectionRow> {
        const row = await this.deps.collections.findForArtist(artistId, collectionId);
        if (!row) {
            throw AppError.notFound('Collection not found.', ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        }
        return row;
    }

    private async requireLive(artistId: string, collectionId: string): Promise<CollectionRow> {
        const row = await this.requireCollection(artistId, collectionId);
        if (row.archivedAt) {
            throw AppError.conflict(
                'This collection has been deleted, so it can no longer be changed.',
                ARTIST_COLLECTION_ERROR_CODES.ARCHIVED,
            );
        }
        return row;
    }

    private async assertNameFree(artistId: string, name: string, exceptId?: string): Promise<void> {
        if (await this.deps.collections.nameTaken(artistId, name, exceptId)) {
            throw AppError.conflict(
                `You already have a collection called "${name}".`,
                ARTIST_COLLECTION_ERROR_CODES.NAME_TAKEN,
            );
        }
    }

    /** `{artist-slug}-{name}`, with `-2`, `-3`… on a clash. */
    private async freeSlug(artistSlug: string, name: string): Promise<string> {
        // Same slugify as artist handles: `kaze` + `Season Two!` → `kaze-season-two`.
        const base = slugify(`${artistSlug}-${name}`).slice(0, ARTIST_SLUG_MAX).replace(/-+$/, '');
        for (let n = 1; n < 100; n += 1) {
            const suffix = n === 1 ? '' : `-${n}`;
            const candidate = `${base.slice(0, ARTIST_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
            if (!(await this.deps.collections.slugTaken(candidate))) return candidate;
        }
        return `${base.slice(0, ARTIST_SLUG_MAX - 9)}-${Date.now().toString(36)}`;
    }

    private slugTaken(slug: string): never {
        throw AppError.conflict(
            `The address "${slug}" is already used by another collection.`,
            ARTIST_COLLECTION_ERROR_CODES.SLUG_TAKEN,
        );
    }

    /** The pre-checks are for the message; the unique index is the authority. */
    private async withSlugGuard<T>(slug: string, write: () => Promise<T>): Promise<T> {
        try {
            return await write();
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                this.slugTaken(slug);
            }
            throw error;
        }
    }

    private requireImages(): IArtistImageStorage {
        if (!this.deps.images) {
            throw AppError.badRequest(
                'Image uploads are not configured on this server.',
                ARTIST_SELF_ERROR_CODES.IMAGES_UNAVAILABLE,
            );
        }
        return this.deps.images;
    }

    private async publish(
        event: string,
        row: CollectionRow,
        artistId: string,
        fields?: string[],
    ): Promise<void> {
        await this.deps.eventBus?.publish(event, {
            collectionId: row.id,
            artistId,
            ...(fields ? { fields } : {}),
        });
    }
}
