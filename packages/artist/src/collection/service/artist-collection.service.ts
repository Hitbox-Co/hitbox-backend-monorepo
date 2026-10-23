import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import {
    ARTIST_AUDIT_EVENTS,
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
    MyCollectionDetailView,
    MyCollectionView,
    ReorderCollectionsDto,
    RestoreCollectionDto,
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
import type { IArtistAuditRecorder } from '../../domain/interfaces/audit-recorder.port';
import { slugify } from '../../profile/domain/artist-role';

export interface ArtistCollectionServiceDeps {
    collections: ArtistCollectionRepository;
    artists: ArtistSelfRepository;
    /** Every change is recorded — `artist.collection.*` in the audit catalog. */
    audit: IArtistAuditRecorder;
    images?: IArtistImageStorage | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    now?: () => Date;
}

/** The two drop counts a view needs beyond the plain relation count. */
interface DropCounts {
    /** Not archived, any status — blocks deleting the collection. */
    live: number;
    /** Active and by the collection's artist — what the artist is shown. */
    active: number;
}

const NO_DROPS: DropCounts = { live: 0, active: 0 };

/** What the audit trail records about a collection, before and after. */
function snapshot(row: CollectionRow) {
    return {
        name: row.name,
        slug: row.slug,
        description: row.description,
        heroImageUrl: row.heroImageUrl,
        position: row.position,
        isPublic: row.isPublic,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
    };
}

function toView(row: CollectionRow, counts: DropCounts): CollectionView {
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
        counts: { drops: row._count.drops, liveDrops: counts.live, activeDrops: counts.active },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function toMine(row: CollectionRow, counts: DropCounts): MyCollectionView {
    const archived = row.archivedAt !== null;
    const blocked = archived ? 'ARCHIVED' : counts.live > 0 ? 'HAS_DROPS' : null;
    return {
        ...toView(row, counts),
        actions: {
            canEdit: !archived,
            canArchive: blocked === null,
            archiveBlockedReason: blocked,
            canRestore: archived,
        },
    };
}

function toAdmin(row: AdminCollectionRow, counts: DropCounts): AdminCollectionView {
    return {
        ...toView(row, counts),
        artist: {
            id: row.artist.id,
            userId: row.artist.userId,
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
 * managers), so there is no "add drop" route here. Products only accepts a
 * live collection of the drop's own artist.
 *
 * **What the artist is shown** is narrower than what the collection holds:
 * only drops that are active (ACTIVE, switched on, not archived) and by this
 * artist. Deleting, though, is blocked by every drop that isn't archived —
 * drafts and drops in review included — because archiving the collection
 * would strand those too. The two numbers are `counts.activeDrops` and
 * `counts.liveDrops`.
 *
 * **Every change is audited** after it is written (the platform's pattern,
 * as in orders and payments), with before/after snapshots.
 */
export class ArtistCollectionService {
    constructor(private readonly deps: ArtistCollectionServiceDeps) { }

    // ── The artist's own ────────────────────────────────────────────────────

    async listMine(userId: string, query: ListMyCollectionsQuery): Promise<MyCollectionView[]> {
        const me = await this.requireArtist(userId);
        const rows = await this.deps.collections.listForArtist(me.id, query.status);
        const counts = await this.dropCounts(rows);
        return rows.map((row) => toMine(row, counts.get(row.id) ?? NO_DROPS));
    }

    /** One collection, with the active drops of this artist inside it. */
    async getMine(userId: string, collectionId: string): Promise<MyCollectionDetailView> {
        const me = await this.requireArtist(userId);
        const row = await this.requireCollection(me.id, collectionId);
        const [view, drops] = await Promise.all([
            this.viewMine(row),
            this.deps.collections.activeDropsOf(row.id, me.id),
        ]);
        return {
            ...view,
            drops: drops.map((d) => ({
                id: d.id,
                publicCode: d.publicCode,
                name: d.name,
                groupCode: d.groupCode,
                totalSupply: d.totalSupply,
                publishedAt: d.publishedAt?.toISOString() ?? null,
                releaseStart: d.releaseStart?.toISOString() ?? null,
                releaseEnd: d.releaseEnd?.toISOString() ?? null,
            })),
        };
    }

    async create(userId: string, dto: CreateCollectionDto): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        await this.assertUnderLimit(me.id);
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

        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_CREATE, userId, row, null, snapshot(row));
        await this.publish(ARTIST_COLLECTION_EVENTS.CREATED, row, me.id);
        this.deps.logger.info({ artistId: me.id, collectionId: row.id }, 'artist collection created');
        return toMine(row, NO_DROPS);
    }

    async update(userId: string, collectionId: string, dto: UpdateCollectionDto): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);
        const before = snapshot(current);

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
        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_UPDATE, userId, row, before, snapshot(row), Object.keys(dto));
        await this.publish(ARTIST_COLLECTION_EVENTS.UPDATED, row, me.id, Object.keys(dto));
        return this.viewMine(row);
    }

    /** DELETE — a soft archive. See the repository for why the row stays. */
    async archive(userId: string, collectionId: string): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);
        const before = snapshot(current);

        const { live } = (await this.dropCounts([current])).get(current.id) ?? NO_DROPS;
        if (live > 0) {
            throw AppError.conflict(
                `This collection still holds ${live} drop${live === 1 ? '' : 's'} (including any not yet on sale). ` +
                'Drops have to be moved to another collection or retired before it can be deleted — ' +
                'ask your brand team or HitBox to do that.',
                ARTIST_COLLECTION_ERROR_CODES.HAS_DROPS,
                { liveDrops: live },
            );
        }

        if ((await this.deps.collections.archive(current.id)) === 0) {
            throw AppError.conflict('This collection is already deleted.', ARTIST_COLLECTION_ERROR_CODES.ARCHIVED);
        }
        await this.closeGaps(me.id);

        const row = (await this.deps.collections.findForArtist(me.id, current.id))!;
        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_ARCHIVE, userId, row, before, snapshot(row));
        await this.publish(ARTIST_COLLECTION_EVENTS.ARCHIVED, row, me.id);
        this.deps.logger.info({ artistId: me.id, collectionId: row.id }, 'artist collection archived');
        return toMine(row, NO_DROPS);
    }

    /**
     * POST /artist/collections/:id/restore — undoes a delete.
     *
     * Comes back **private** and at the **end** of the list, whatever it was
     * before: the storefront shouldn't change without the artist choosing to
     * republish it. The slug was held while it was archived, so it is still
     * theirs; the name may have been reused since, in which case the artist
     * sends a new one.
     */
    async restore(userId: string, collectionId: string, dto: RestoreCollectionDto): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireCollection(me.id, collectionId);
        if (!current.archivedAt) {
            throw AppError.conflict(
                'This collection is not deleted, so there is nothing to restore.',
                ARTIST_COLLECTION_ERROR_CODES.NOT_ARCHIVED,
            );
        }
        const before = snapshot(current);
        const name = dto.name ?? current.name;

        await this.assertUnderLimit(me.id);
        await this.assertNameFree(me.id, name, current.id, Boolean(dto.name));

        const position = await this.deps.collections.nextPosition(me.id);
        const restored = await this.deps.collections.restore(current.id, {
            position,
            ...(dto.name !== undefined && { name: dto.name }),
        });
        if (restored === 0) {
            throw AppError.conflict(
                'This collection was restored a moment ago.',
                ARTIST_COLLECTION_ERROR_CODES.NOT_ARCHIVED,
            );
        }

        const row = (await this.deps.collections.findForArtist(me.id, current.id))!;
        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_RESTORE, userId, row, before, snapshot(row));
        await this.publish(ARTIST_COLLECTION_EVENTS.RESTORED, row, me.id);
        this.deps.logger.info({ artistId: me.id, collectionId: row.id }, 'artist collection restored');
        return this.viewMine(row);
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
        await this.deps.audit.record({
            eventType: ARTIST_AUDIT_EVENTS.COLLECTION_REORDER,
            actor: { type: 'ARTIST', id: userId },
            result: 'SUCCESS',
            organizationId: me.organizationId,
            resource: { type: 'Artist', id: me.id },
            beforeState: { order: live },
            afterState: { order: dto.collectionIds },
            correlationId: randomUUID(),
        });
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

        const before = snapshot(current);
        const row = await this.deps.collections.update(current.id, { heroImageUrl: asset.publicUrl });
        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_UPDATE, userId, row, before, snapshot(row), ['heroImageUrl'], { assetId: dto.assetId });
        await this.publish(ARTIST_COLLECTION_EVENTS.UPDATED, row, me.id, ['heroImageUrl']);
        return this.viewMine(row);
    }

    async removeHero(userId: string, collectionId: string): Promise<MyCollectionView> {
        const me = await this.requireEditableArtist(userId);
        const current = await this.requireLive(me.id, collectionId);
        const before = snapshot(current);
        const row = await this.deps.collections.update(current.id, { heroImageUrl: null });
        await this.audit(ARTIST_AUDIT_EVENTS.COLLECTION_UPDATE, userId, row, before, snapshot(row), ['heroImageUrl']);
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
        const counts = await this.dropCounts(items);
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => toAdmin(row, counts.get(row.id) ?? NO_DROPS)),
        };
    }

    /**
     * Monitoring sees every drop in the collection — not just what the artist
     * is shown — with `shownToArtist` / `sameArtist` saying which is which.
     */
    async adminGet(collectionId: string): Promise<AdminCollectionDetailView> {
        const row = await this.deps.collections.adminFind(collectionId);
        if (!row) {
            throw AppError.notFound('Collection not found.', ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        }
        const [counts, drops] = await Promise.all([
            this.dropCounts([row]),
            this.deps.collections.dropsOf(row.id),
        ]);
        return {
            ...toAdmin(row, counts.get(row.id) ?? NO_DROPS),
            drops: drops.map((d) => {
                const sameArtist = d.artistId === row.artistId;
                return {
                    id: d.id,
                    name: d.name,
                    status: d.status,
                    archivedAt: d.archivedAt?.toISOString() ?? null,
                    createdAt: d.createdAt.toISOString(),
                    shownToArtist: sameArtist && d.status === 'ACTIVE' && d.isActive && d.archivedAt === null,
                    sameArtist,
                };
            }),
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

    private async dropCounts(rows: { id: string; artistId: string }[]): Promise<Map<string, DropCounts>> {
        const ids = rows.map((r) => r.id);
        const [live, active] = await Promise.all([
            this.deps.collections.liveDropCounts(ids),
            this.deps.collections.activeDropCounts(rows),
        ]);
        return new Map(ids.map((id) => [id, { live: live.get(id) ?? 0, active: active.get(id) ?? 0 }]));
    }

    private async viewMine(row: CollectionRow): Promise<MyCollectionView> {
        return toMine(row, (await this.dropCounts([row])).get(row.id) ?? NO_DROPS);
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
                'This collection has been deleted, so it can no longer be changed. Restore it first.',
                ARTIST_COLLECTION_ERROR_CODES.ARCHIVED,
            );
        }
        return row;
    }

    private async assertUnderLimit(artistId: string): Promise<void> {
        if ((await this.deps.collections.countLive(artistId)) >= MAX_LIVE_COLLECTIONS_PER_ARTIST) {
            throw AppError.conflict(
                `You already have ${MAX_LIVE_COLLECTIONS_PER_ARTIST} collections. Delete one first.`,
                ARTIST_COLLECTION_ERROR_CODES.LIMIT_REACHED,
                { max: MAX_LIVE_COLLECTIONS_PER_ARTIST },
            );
        }
    }

    private async assertNameFree(artistId: string, name: string, exceptId?: string, chosen = true): Promise<void> {
        if (await this.deps.collections.nameTaken(artistId, name, exceptId)) {
            throw AppError.conflict(
                chosen
                    ? `You already have a collection called "${name}".`
                    : `You now have another collection called "${name}". Restore this one with a new name.`,
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

    /** Renumbers the live list 0…n-1 after one leaves it. */
    private async closeGaps(artistId: string): Promise<void> {
        const remaining = (await this.deps.collections.listForArtist(artistId, 'live')).map((r) => r.id);
        if (remaining.length > 0) await this.deps.collections.reorder(artistId, remaining);
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

    private async audit(
        eventType: string,
        userId: string,
        row: CollectionRow,
        before: ReturnType<typeof snapshot> | null,
        after: ReturnType<typeof snapshot>,
        fields?: string[],
        extra?: Record<string, string>,
    ): Promise<void> {
        await this.deps.audit.record({
            eventType,
            actor: { type: 'ARTIST', id: userId },
            result: 'SUCCESS',
            organizationId: row.organizationId,
            resource: { type: 'ArtistCollection', id: row.id },
            beforeState: before,
            afterState: after,
            correlationId: randomUUID(),
            metadata: { artistId: row.artistId, ...(fields ? { fields } : {}), ...(extra ?? {}) },
        });
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
