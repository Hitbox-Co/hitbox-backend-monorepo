import { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { CONTENT_ERROR_CODES } from '../constants/content.constant';
import type { IRewardMedia, RewardUploadTicket } from '../domain/reward-media.port';
import type { ArtistRewardView } from '../dto/reward.views';
import type { ContentRepository, RewardRow } from '../repository/content.repository';
import { isOpen, itemCounts, itemViews, moderationOf } from './reward-mapping';
import { assertRoom, assertSameItems, assertUploadable, assertUsableAsset, duplicateFile, requireMedia } from './reward-files';
import type { RewardUnlockService } from './reward-unlock.service';

interface CollectionRewardServiceDeps {
    content: ContentRepository;
    unlocks: RewardUnlockService;
    media?: IRewardMedia | undefined;
    now?: () => Date;
}

/** What a save did, for the caller's audit trail. */
export interface RewardSaveResult {
    reward: ArtistRewardView;
    created: boolean;
    /** It had been removed and this save brought it back. */
    restored: boolean;
    /** Buyers who already held the full set and got it with this save. */
    newlyUnlocked: number;
}

/**
 * Managing a collection's reward — the provider side of the artist module's
 * `ICollectionRewards` port.
 *
 * No ownership check here, on purpose: the artist module has already proven
 * the caller is the artist who owns this collection, and that the collection
 * is live, before it calls. This service owns the reward rules — one reward
 * per collection, what a reward file may be, how many — and the switch-on
 * grant.
 */
export class CollectionRewardService {
    constructor(private readonly deps: CollectionRewardServiceDeps) { }

    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /** The reward, removed ones included (so the artist can restore it). Null when there never was one. */
    async get(collectionId: string): Promise<ArtistRewardView | null> {
        const row = await this.deps.content.findRewardOfCollection(collectionId);
        return row ? this.view(row) : null;
    }

    /**
     * Creates the reward, or edits it. Saving a removed reward restores it —
     * its files and the buyers' unlocks are still there.
     *
     * Whenever this leaves the reward on when it wasn't before (new, restored,
     * or switched back on), everyone who already holds the full set gets it
     * immediately.
     */
    async save(input: {
        collectionId: string;
        name: string;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
    }): Promise<RewardSaveResult> {
        const now = this.now();
        let existing = await this.deps.content.findRewardOfCollection(input.collectionId);
        let created = false;

        if (!existing) {
            try {
                existing = await this.deps.content.createReward({
                    collectionId: input.collectionId,
                    name: input.name,
                    description: input.description ?? null,
                    isActive: input.isActive ?? true,
                    now,
                });
                created = true;
            } catch (error) {
                // Two saves at once: the partial unique index let one through.
                if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
                existing = await this.deps.content.findRewardOfCollection(input.collectionId);
                if (!existing) throw error;
            }
        }

        // HitBox switched it off or removed it: the artist may still edit the
        // name, description and files, but not bring it back.
        if (!created && existing.moderationLockedAt != null) {
            const reviving = existing.archivedAt !== null || (input.isActive === true && !existing.isActive);
            if (reviving) {
                throw AppError.conflict(
                    'HitBox has ' + (existing.archivedAt ? 'removed' : 'switched off') +
                    ' this reward' + (existing.moderationReason ? `: ${existing.moderationReason}` : '.') +
                    ' Contact HitBox support to have it reviewed.',
                    CONTENT_ERROR_CODES.MODERATION_LOCKED,
                    { reason: existing.moderationReason },
                );
            }
        }

        const wasOpen = !created && isOpen(existing);
        const restored = !created && existing.archivedAt !== null;
        const row = created
            ? existing
            : await this.deps.content.updateReward(
                existing.id,
                {
                    name: input.name,
                    ...(input.description !== undefined ? { description: input.description } : {}),
                    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
                    ...(restored ? { archivedAt: null } : {}),
                },
                now,
            );

        const newlyUnlocked = isOpen(row) && !wasOpen ? await this.deps.unlocks.grantToCompleters(row) : 0;
        return { reward: await this.view(row), created, restored, newlyUnlocked };
    }

    /**
     * Removes the reward: buyers can no longer open it and nobody new unlocks
     * it. Kept, with its files and unlocks, so saving it again restores it.
     */
    async remove(collectionId: string): Promise<ArtistRewardView> {
        const row = await this.requireReward(collectionId);
        if (row.archivedAt) return this.view(row);
        return this.view(await this.deps.content.updateReward(row.id, { archivedAt: this.now() }, this.now()));
    }

    /**
     * Step 1 of adding a file: a presigned URL to PUT it to. Nothing is added
     * to the reward until step 2 (`addItem`) names the uploaded asset.
     */
    async createItemUpload(input: {
        collectionId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<RewardUploadTicket & { kind: string }> {
        const media = requireMedia(this.deps.media);
        const row = await this.requireLiveReward(input.collectionId);
        assertRoom(row.contentBundleItems.length);
        const kind = assertUploadable(input.mimeType, input.sizeBytes);
        const ticket = await media.createUpload({
            collectionId: input.collectionId,
            uploadedById: input.uploadedById,
            fileName: input.fileName,
            mimeType: input.mimeType.trim().toLowerCase(),
            sizeBytes: input.sizeBytes,
        });
        return { ...ticket, kind };
    }

    /** Step 2: put the uploaded file into the reward, at the end. */
    async addItem(input: { collectionId: string; assetId: string; title?: string | null | undefined }): Promise<ArtistRewardView> {
        const media = requireMedia(this.deps.media);
        const row = await this.requireLiveReward(input.collectionId);
        assertRoom(row.contentBundleItems.length);
        if (row.contentBundleItems.some((item) => item.assetId === input.assetId)) throw duplicateFile();

        const [asset] = await media.inspect([input.assetId]);
        assertUsableAsset(
            asset,
            input.assetId,
            (a) => a.collectionId === input.collectionId,
            'it was not uploaded to this collection.',
        );

        try {
            await this.deps.content.addItem({
                bundleId: row.id,
                assetId: input.assetId,
                title: input.title ?? null,
                now: this.now(),
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateFile();
            throw error;
        }
        return this.view(await this.requireReward(input.collectionId));
    }

    async updateItem(input: { collectionId: string; itemId: string; title: string | null }): Promise<ArtistRewardView> {
        const row = await this.requireLiveReward(input.collectionId);
        this.requireItem(row, input.itemId);
        await this.deps.content.updateItemTitle(input.itemId, input.title, row.id, this.now());
        return this.view(await this.requireReward(input.collectionId));
    }

    /** The full new order: every item of the reward, each once. */
    async reorderItems(input: { collectionId: string; itemIds: string[] }): Promise<ArtistRewardView> {
        const row = await this.requireLiveReward(input.collectionId);
        assertSameItems(row.contentBundleItems.map((item) => item.id), input.itemIds);
        await this.deps.content.reorderItems(row.id, input.itemIds, this.now());
        return this.view(await this.requireReward(input.collectionId));
    }

    /** Takes a file out of the reward. The file itself is kept (history, audits). */
    async removeItem(input: { collectionId: string; itemId: string }): Promise<ArtistRewardView> {
        const row = await this.requireLiveReward(input.collectionId);
        this.requireItem(row, input.itemId);
        await this.deps.content.removeItem(row.id, input.itemId, this.now());
        return this.view(await this.requireReward(input.collectionId));
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async view(row: RewardRow): Promise<ArtistRewardView> {
        const now = this.now();
        const [unlockedCount, drops, items] = await Promise.all([
            this.deps.content.countLiveGrants(row.id, now),
            row.collectionId ? this.deps.content.releasedDrops(row.collectionId) : Promise.resolve([]),
            // The artist previews their own files, so they get links.
            itemViews(row.contentBundleItems, this.deps.media, true),
        ]);
        return {
            id: row.id,
            publicCode: row.publicCode,
            collectionId: row.collectionId!,
            name: row.name,
            description: row.description,
            status: row.archivedAt ? 'REMOVED' : row.isActive ? 'ON' : 'OFF',
            isActive: row.isActive,
            archivedAt: row.archivedAt?.toISOString() ?? null,
            items,
            itemCounts: itemCounts(row.contentBundleItems),
            unlockedCount,
            requiredDrops: drops.length,
            moderation: moderationOf(row),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    }

    private async requireReward(collectionId: string): Promise<RewardRow> {
        const row = await this.deps.content.findRewardOfCollection(collectionId);
        if (!row) {
            throw AppError.notFound(
                'This collection has no reward yet. Create it first (PUT …/reward).',
                CONTENT_ERROR_CODES.REWARD_NOT_FOUND,
            );
        }
        return row;
    }

    private async requireLiveReward(collectionId: string): Promise<RewardRow> {
        const row = await this.requireReward(collectionId);
        if (row.archivedAt) {
            throw AppError.conflict(
                'This reward was removed. Save it again (PUT …/reward) to restore it first.',
                CONTENT_ERROR_CODES.REWARD_ARCHIVED,
            );
        }
        return row;
    }

    private requireItem(row: RewardRow, itemId: string): void {
        if (!row.contentBundleItems.some((item) => item.id === itemId)) {
            throw AppError.notFound('No such file in this reward.', CONTENT_ERROR_CODES.ITEM_NOT_FOUND);
        }
    }
}
