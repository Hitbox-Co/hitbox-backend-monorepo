import { randomUUID } from 'node:crypto';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { ARTIST_SELF_ERROR_CODES } from '../../self/constants/artist-self.constant';
import type { ArtistSelfRepository, ArtistSelfRow } from '../../self/repository/artist-self.repository';
import type { IArtistAuditRecorder } from '../../domain/interfaces/audit-recorder.port';
import type { IDropCollectionMembership, MembershipDrop } from '../../collection/domain/drop-membership.port';
import type {
    AddRewardItemDto,
    ReorderRewardItemsDto,
    RewardUploadDto,
    UpdateRewardItemDto,
} from '../../collection/dto/collection-reward.dto';
import { ARTIST_DROP_AUDIT_EVENTS, ARTIST_DROP_ERROR_CODES, ARTIST_DROP_EVENTS } from '../constants/artist-drop.constant';
import type {
    DropContentOverview,
    DropContentUploadTicket,
    DropContentView,
    IDropContent,
} from '../domain/drop-content.port';
import type { CreateDropContentDto, UpdateDropContentDto } from '../dto/drop-content.dto';

interface ArtistDropContentServiceDeps {
    artists: ArtistSelfRepository;
    drops?: IDropCollectionMembership | undefined;
    content?: IDropContent | undefined;
    audit: IArtistAuditRecorder;
    eventBus?: IEventBus | undefined;
}

/**
 * An artist managing the content on their own drops: the regular content
 * every owner opens, and exclusive tiers only the owners of specific units
 * (by serial number) open. docs/content/drop-content.md.
 *
 * "Which drop" is always one of the caller's own (`Drop.artistId` = their
 * artist); somebody else's drop is a 404, the same as one that doesn't exist.
 * Changes need an editable profile. The content rules are the content
 * module's, behind `IDropContent`.
 *
 * Every change is audited (`artist.drop.content.*`).
 */
export class ArtistDropContentService {
    constructor(private readonly deps: ArtistDropContentServiceDeps) { }

    async overview(userId: string, dropId: string): Promise<DropContentOverview> {
        const content = this.requireContent();
        await this.requireDrop(await this.requireArtist(userId), dropId);
        return content.overview(dropId);
    }

    async get(userId: string, dropId: string, bundleId: string): Promise<DropContentView> {
        const content = this.requireContent();
        await this.requireDrop(await this.requireArtist(userId), dropId);
        return content.get(dropId, bundleId);
    }

    async create(userId: string, dropId: string, dto: CreateDropContentDto): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const after = await content.create({ dropId, ...dto });
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_SAVE, userId, drop, null, after, {
            action: 'create',
            tier: after.tier,
            ...(after.tier === 'EXCLUSIVE' ? { serialCount: after.serialNumbers.length } : {}),
        });
        await this.publish(drop, after);
        return after;
    }

    async update(userId: string, dropId: string, bundleId: string, dto: UpdateDropContentDto): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.update({ dropId, bundleId, ...dto });
        const added = after.serialNumbers.filter((n) => !before.serialNumbers.includes(n));
        const removed = before.serialNumbers.filter((n) => !after.serialNumbers.includes(n));
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_SAVE, userId, drop, before, after, {
            action: 'update',
            tier: after.tier,
            fields: Object.keys(dto),
            ...(added.length > 0 ? { serialsAdded: added.slice(0, 100) } : {}),
            ...(removed.length > 0 ? { serialsRemoved: removed.slice(0, 100) } : {}),
        });
        await this.publish(drop, after);
        return after;
    }

    async remove(userId: string, dropId: string, bundleId: string): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const { view, changed } = await content.remove({ dropId, bundleId });
        if (changed) {
            await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_REMOVE, userId, drop, before, view, { tier: view.tier });
            await this.publish(drop, view);
        }
        return view;
    }

    async restore(userId: string, dropId: string, bundleId: string): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.restore({ dropId, bundleId });
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_SAVE, userId, drop, before, after, {
            action: 'restore',
            tier: after.tier,
        });
        await this.publish(drop, after);
        return after;
    }

    /** Step 1 of adding a file. Not audited: nothing changes until step 2. */
    async createItemUpload(userId: string, dropId: string, bundleId: string, dto: RewardUploadDto): Promise<DropContentUploadTicket> {
        const content = this.requireContent();
        await this.requireWritable(userId, dropId);
        return content.createItemUpload({ dropId, bundleId, uploadedById: userId, ...dto });
    }

    async addItem(userId: string, dropId: string, bundleId: string, dto: AddRewardItemDto): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.addItem({ dropId, bundleId, assetId: dto.assetId, title: dto.title });
        const added = after.items.find((item) => item.assetId === dto.assetId);
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_ITEM_ADD, userId, drop, before, after, {
            tier: after.tier,
            assetId: dto.assetId,
            ...(added ? { itemId: added.id, kind: added.kind ?? 'UNKNOWN' } : {}),
        });
        await this.publish(drop, after);
        return after;
    }

    async updateItem(userId: string, dropId: string, bundleId: string, itemId: string, dto: UpdateRewardItemDto): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.updateItem({ dropId, bundleId, itemId, title: dto.title });
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_ITEM_UPDATE, userId, drop, before, after, {
            tier: after.tier,
            itemId,
            action: 'rename',
        });
        return after;
    }

    async reorderItems(userId: string, dropId: string, bundleId: string, dto: ReorderRewardItemsDto): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.reorderItems({ dropId, bundleId, itemIds: dto.itemIds });
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_ITEM_UPDATE, userId, drop, before, after, {
            tier: after.tier,
            action: 'reorder',
        });
        return after;
    }

    async removeItem(userId: string, dropId: string, bundleId: string, itemId: string): Promise<DropContentView> {
        const content = this.requireContent();
        const { drop } = await this.requireWritable(userId, dropId);
        const before = await content.get(dropId, bundleId);
        const after = await content.removeItem({ dropId, bundleId, itemId });
        const removed = before.items.find((item) => item.id === itemId);
        await this.audit(ARTIST_DROP_AUDIT_EVENTS.CONTENT_ITEM_REMOVE, userId, drop, before, after, {
            tier: after.tier,
            itemId,
            ...(removed ? { assetId: removed.assetId } : {}),
        });
        await this.publish(drop, after);
        return after;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireWritable(userId: string, dropId: string): Promise<{ artist: ArtistSelfRow; drop: MembershipDrop }> {
        const artist = await this.requireArtist(userId);
        if (artist.archivedAt !== null || !artist.isActive) {
            throw AppError.conflict(
                'Your artist profile is ' + (artist.archivedAt ? 'archived' : 'deactivated') +
                ', so its drops cannot be changed. Contact HitBox support.',
                ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED,
            );
        }
        return { artist, drop: await this.requireDrop(artist, dropId) };
    }

    private async requireArtist(userId: string): Promise<ArtistSelfRow> {
        const row = await this.deps.artists.findByUserId(userId);
        if (!row) {
            throw AppError.notFound('Your account is not linked to an artist profile.', ARTIST_SELF_ERROR_CODES.PROFILE_NOT_FOUND);
        }
        return row;
    }

    /** One of the caller's own drops — anyone else's is a 404, like one that doesn't exist. */
    private async requireDrop(artist: ArtistSelfRow, dropId: string): Promise<MembershipDrop> {
        if (!this.deps.drops) {
            // 400, not 503: a 5xx AppError is rendered as an opaque 500.
            throw AppError.badRequest('Drops are not available on this server.', ARTIST_DROP_ERROR_CODES.DROPS_UNAVAILABLE);
        }
        const [drop] = await this.deps.drops.findDrops([dropId]);
        if (!drop || drop.artistId !== artist.id) {
            throw AppError.notFound('Drop not found.', ARTIST_DROP_ERROR_CODES.DROP_NOT_FOUND);
        }
        return drop;
    }

    private requireContent(): IDropContent {
        if (!this.deps.content) {
            throw AppError.badRequest('Drop content is not available on this server.', ARTIST_DROP_ERROR_CODES.CONTENT_UNAVAILABLE);
        }
        return this.deps.content;
    }

    private async audit(
        eventType: string,
        userId: string,
        drop: MembershipDrop,
        before: DropContentView | null,
        after: DropContentView,
        extra: Record<string, string | number | boolean | string[] | number[]> = {},
    ): Promise<void> {
        await this.deps.audit.record({
            eventType,
            actor: { type: 'ARTIST', id: userId },
            result: 'SUCCESS',
            resource: { type: 'ContentBundle', id: after.id },
            beforeState: before ? snapshot(before) : null,
            afterState: snapshot(after),
            correlationId: randomUUID(),
            metadata: { artistId: drop.artistId, dropId: drop.id, ...extra },
        });
    }

    private async publish(drop: MembershipDrop, view: DropContentView): Promise<void> {
        await this.deps.eventBus?.publish(ARTIST_DROP_EVENTS.CONTENT_CHANGED, {
            dropId: drop.id,
            artistId: drop.artistId,
            bundleId: view.id,
            tier: view.tier,
            status: view.status,
            itemCount: view.items.length,
        });
    }
}

function snapshot(view: DropContentView) {
    return {
        tier: view.tier,
        name: view.name,
        description: view.description,
        status: view.status,
        // Enough to see what changed without storing a 1000-entry list per event.
        serialCount: view.serialNumbers.length,
        serialNumbers: view.serialNumbers.slice(0, 100),
        items: view.items.map((item) => ({ id: item.id, assetId: item.assetId, kind: item.kind, title: item.title })),
    };
}
