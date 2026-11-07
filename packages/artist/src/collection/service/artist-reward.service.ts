import { randomUUID } from 'node:crypto';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { ARTIST_SELF_ERROR_CODES } from '../../self/constants/artist-self.constant';
import type { ArtistSelfRepository, ArtistSelfRow } from '../../self/repository/artist-self.repository';
import type { IArtistAuditRecorder } from '../../domain/interfaces/audit-recorder.port';
import {
    ARTIST_AUDIT_EVENTS,
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
} from '../constants/artist-collection.constant';
import type {
    CollectionRewardUploadTicket,
    CollectionRewardView,
    ICollectionRewards,
} from '../domain/collection-rewards.port';
import type {
    AddRewardItemDto,
    ReorderRewardItemsDto,
    RewardUploadDto,
    SaveRewardDto,
    UpdateRewardItemDto,
} from '../dto/collection-reward.dto';
import type { ArtistCollectionRepository, CollectionRow } from '../repository/artist-collection.repository';

interface ArtistRewardServiceDeps {
    collections: ArtistCollectionRepository;
    artists: ArtistSelfRepository;
    audit: IArtistAuditRecorder;
    rewards?: ICollectionRewards | undefined;
    eventBus?: IEventBus | undefined;
}

/**
 * An artist managing the reward on their own collection — the exclusive
 * content a buyer unlocks by collecting every released drop of it.
 *
 * "Which collection" is always one of the caller's own, found through
 * `Artist.userId`; somebody else's collection is a 404, the same as one that
 * doesn't exist. Changes need a live collection and an editable profile, like
 * every other collection change. The reward itself — its rules, its files,
 * the buyers' unlocks — is the content module's, behind `ICollectionRewards`.
 *
 * Every change is audited (`artist.collection.reward.*`).
 */
export class ArtistRewardService {
    constructor(private readonly deps: ArtistRewardServiceDeps) { }

    async get(userId: string, collectionId: string): Promise<CollectionRewardView | null> {
        const rewards = this.requireRewards();
        const artist = await this.requireArtist(userId);
        await this.requireCollection(artist.id, collectionId);
        return rewards.get(collectionId);
    }

    async save(userId: string, collectionId: string, dto: SaveRewardDto): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await rewards.get(collectionId);
        const result = await rewards.save({ collectionId, ...dto });

        await this.audit(ARTIST_AUDIT_EVENTS.REWARD_SAVE, userId, collection, before, result.reward, {
            ...(result.created ? { created: true } : {}),
            ...(result.restored ? { restored: true } : {}),
            ...(result.newlyUnlocked > 0 ? { newlyUnlocked: result.newlyUnlocked } : {}),
            fields: Object.keys(dto),
        });
        await this.publish(ARTIST_COLLECTION_EVENTS.REWARD_SAVED, collection, result.reward);
        return result.reward;
    }

    async remove(userId: string, collectionId: string): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await this.requireExisting(collectionId);
        const after = await rewards.remove(collectionId);
        if (before.archivedAt === null) {
            await this.audit(ARTIST_AUDIT_EVENTS.REWARD_REMOVE, userId, collection, before, after);
            await this.publish(ARTIST_COLLECTION_EVENTS.REWARD_REMOVED, collection, after);
        }
        return after;
    }

    /** Step 1 of adding a file. Not audited: nothing changes until step 2. */
    async createItemUpload(
        userId: string,
        collectionId: string,
        dto: RewardUploadDto,
    ): Promise<CollectionRewardUploadTicket> {
        const rewards = this.requireRewards();
        await this.requireWritable(userId, collectionId);
        return rewards.createItemUpload({ collectionId, uploadedById: userId, ...dto });
    }

    async addItem(userId: string, collectionId: string, dto: AddRewardItemDto): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await this.requireExisting(collectionId);
        const after = await rewards.addItem({ collectionId, assetId: dto.assetId, title: dto.title });
        const added = after.items.find((item) => item.assetId === dto.assetId);
        await this.audit(ARTIST_AUDIT_EVENTS.REWARD_ITEM_ADD, userId, collection, before, after, {
            assetId: dto.assetId,
            ...(added ? { itemId: added.id, kind: added.kind ?? 'UNKNOWN' } : {}),
        });
        await this.publish(ARTIST_COLLECTION_EVENTS.REWARD_SAVED, collection, after);
        return after;
    }

    async updateItem(
        userId: string,
        collectionId: string,
        itemId: string,
        dto: UpdateRewardItemDto,
    ): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await this.requireExisting(collectionId);
        const after = await rewards.updateItem({ collectionId, itemId, title: dto.title });
        await this.audit(ARTIST_AUDIT_EVENTS.REWARD_ITEM_UPDATE, userId, collection, before, after, {
            itemId,
            action: 'rename',
        });
        return after;
    }

    async reorderItems(userId: string, collectionId: string, dto: ReorderRewardItemsDto): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await this.requireExisting(collectionId);
        const after = await rewards.reorderItems({ collectionId, itemIds: dto.itemIds });
        await this.audit(ARTIST_AUDIT_EVENTS.REWARD_ITEM_UPDATE, userId, collection, before, after, {
            action: 'reorder',
        });
        return after;
    }

    async removeItem(userId: string, collectionId: string, itemId: string): Promise<CollectionRewardView> {
        const rewards = this.requireRewards();
        const { collection } = await this.requireWritable(userId, collectionId);
        const before = await this.requireExisting(collectionId);
        const after = await rewards.removeItem({ collectionId, itemId });
        const removed = before.items.find((item) => item.id === itemId);
        await this.audit(ARTIST_AUDIT_EVENTS.REWARD_ITEM_REMOVE, userId, collection, before, after, {
            itemId,
            ...(removed ? { assetId: removed.assetId } : {}),
        });
        await this.publish(ARTIST_COLLECTION_EVENTS.REWARD_SAVED, collection, after);
        return after;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireWritable(userId: string, collectionId: string): Promise<{ artist: ArtistSelfRow; collection: CollectionRow }> {
        const artist = await this.requireArtist(userId);
        if (artist.archivedAt !== null || !artist.isActive) {
            throw AppError.conflict(
                'Your artist profile is ' + (artist.archivedAt ? 'archived' : 'deactivated') +
                ', so its collections cannot be changed. Contact HitBox support.',
                ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED,
            );
        }
        const collection = await this.requireCollection(artist.id, collectionId);
        if (collection.archivedAt) {
            throw AppError.conflict(
                'This collection has been deleted, so it can no longer be changed. Restore it first.',
                ARTIST_COLLECTION_ERROR_CODES.ARCHIVED,
            );
        }
        return { artist, collection };
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

    private async requireCollection(artistId: string, collectionId: string): Promise<CollectionRow> {
        const row = await this.deps.collections.findForArtist(artistId, collectionId);
        if (!row) {
            throw AppError.notFound('Collection not found.', ARTIST_COLLECTION_ERROR_CODES.NOT_FOUND);
        }
        return row;
    }

    /** The reward, for a before-snapshot; 404 (from content) when there is none. */
    private async requireExisting(collectionId: string): Promise<CollectionRewardView> {
        const reward = await this.requireRewards().get(collectionId);
        if (!reward) {
            throw AppError.notFound(
                'This collection has no reward yet. Create it first (PUT …/reward).',
                ARTIST_COLLECTION_ERROR_CODES.REWARD_NOT_FOUND,
            );
        }
        return reward;
    }

    private requireRewards(): ICollectionRewards {
        if (!this.deps.rewards) {
            // 400, not 503: a 5xx AppError is rendered as an opaque 500.
            throw AppError.badRequest(
                'Collection rewards are not available on this server.',
                ARTIST_COLLECTION_ERROR_CODES.REWARDS_UNAVAILABLE,
            );
        }
        return this.deps.rewards;
    }

    private async audit(
        eventType: string,
        userId: string,
        collection: CollectionRow,
        before: CollectionRewardView | null,
        after: CollectionRewardView,
        extra: Record<string, string | number | boolean | string[]> = {},
    ): Promise<void> {
        await this.deps.audit.record({
            eventType,
            actor: { type: 'ARTIST', id: userId },
            result: 'SUCCESS',
            organizationId: collection.organizationId,
            resource: { type: 'ContentBundle', id: after.id },
            beforeState: before ? snapshot(before) : null,
            afterState: snapshot(after),
            correlationId: randomUUID(),
            metadata: { artistId: collection.artistId, collectionId: collection.id, ...extra },
        });
    }

    private async publish(event: string, collection: CollectionRow, reward: CollectionRewardView): Promise<void> {
        await this.deps.eventBus?.publish(event, {
            collectionId: collection.id,
            artistId: collection.artistId,
            rewardId: reward.id,
            status: reward.status,
            itemCount: reward.items.length,
        });
    }
}

function snapshot(view: CollectionRewardView) {
    return {
        name: view.name,
        description: view.description,
        status: view.status,
        items: view.items.map((item) => ({ id: item.id, assetId: item.assetId, kind: item.kind, title: item.title })),
    };
}
