import { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import {
    CONTENT_ERROR_CODES,
    DROP_CONTENT_ERROR_CODES,
    MAX_EXCLUSIVE_TIERS_PER_DROP,
    MAX_REWARD_ITEMS,
    MAX_SERIALS_PER_TIER,
} from '../constants/content.constant';
import type { DropContentTier } from '../constants/content.constant';
import type { IRewardMedia, RewardUploadTicket } from '../domain/reward-media.port';
import type { ArtistDropContentOverview, ArtistDropContentView } from '../dto/drop-content.views';
import type { ContentRepository } from '../repository/content.repository';
import { serialsOf, tierOf } from '../repository/drop-content.repository';
import type { DropContentRepository, DropContentRow, DropRef } from '../repository/drop-content.repository';
import { itemCounts, itemViews } from './reward-mapping';
import { assertRoom, assertSameItems, assertUploadable, assertUsableAsset, duplicateFile, requireMedia } from './reward-files';

interface DropContentServiceDeps {
    content: ContentRepository;
    drops: DropContentRepository;
    media?: IRewardMedia | undefined;
    now?: () => Date;
}

/**
 * Managing a drop's content — the provider side of the artist module's
 * `IDropContent` port. docs/content/drop-content.md.
 *
 * A drop has at most one REGULAR tier (every owner of a unit of the drop opens
 * it) and up to MAX_EXCLUSIVE_TIERS_PER_DROP EXCLUSIVE tiers, each naming the
 * units that open it by serial number. Exclusive content comes on top of the
 * regular content: the owner of #001 sees both.
 *
 * No ownership check here, on purpose: the artist module has already proven
 * the caller is the artist of this drop before it calls. This service owns
 * the content rules — tiers, serial numbers, files.
 */
export class DropContentService {
    constructor(private readonly deps: DropContentServiceDeps) { }

    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /** Everything on the drop, removed tiers included (so they can be restored). */
    async overview(dropId: string): Promise<ArtistDropContentOverview> {
        const drop = await this.requireDrop(dropId);
        const rows = await this.deps.drops.listForDrop(dropId);
        const views = await this.views(rows);
        return {
            drop: dropRef(drop),
            regular: views.find((v) => v.tier === 'REGULAR') ?? null,
            exclusive: views.filter((v) => v.tier === 'EXCLUSIVE'),
            limits: {
                maxExclusiveTiers: MAX_EXCLUSIVE_TIERS_PER_DROP,
                maxSerialsPerTier: MAX_SERIALS_PER_TIER,
                maxItemsPerTier: MAX_REWARD_ITEMS,
            },
        };
    }

    async get(dropId: string, bundleId: string): Promise<ArtistDropContentView> {
        return this.view(await this.requireBundle(dropId, bundleId));
    }

    /**
     * Creates a tier. REGULAR: one per drop, no serial numbers. EXCLUSIVE:
     * at least one serial number, each within 1…totalSupply.
     */
    async create(input: {
        dropId: string;
        tier: DropContentTier;
        name: string;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
        serialNumbers?: number[] | undefined;
    }): Promise<ArtistDropContentView> {
        const drop = await this.requireDrop(input.dropId);
        const serialNumbers = this.checkSerials(drop, input.tier, input.serialNumbers, true);

        if (input.tier === 'REGULAR') {
            const existing = (await this.deps.drops.listForDrop(drop.id)).find((row) => tierOf(row) === 'REGULAR');
            if (existing) throw regularExists(existing.id);
        } else if ((await this.deps.drops.countExclusive(drop.id)) >= MAX_EXCLUSIVE_TIERS_PER_DROP) {
            throw AppError.conflict(
                `A drop can have at most ${MAX_EXCLUSIVE_TIERS_PER_DROP} exclusive tiers. Edit or reuse one instead.`,
                DROP_CONTENT_ERROR_CODES.TOO_MANY_TIERS,
                { max: MAX_EXCLUSIVE_TIERS_PER_DROP },
            );
        }

        try {
            const row = await this.deps.drops.create({
                dropId: drop.id,
                tier: input.tier,
                name: input.name,
                description: input.description ?? null,
                isActive: input.isActive ?? true,
                serialNumbers,
                now: this.now(),
            });
            return this.view(row);
        } catch (error) {
            // Two regular creates at once: the partial unique index let one through.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const winner = (await this.deps.drops.listForDrop(drop.id)).find((row) => tierOf(row) === 'REGULAR');
                throw regularExists(winner?.id ?? null);
            }
            throw error;
        }
    }

    /**
     * Edits a tier. `serialNumbers` (EXCLUSIVE only) replaces the whole list —
     * owners of units taken off it lose access at once, owners of units added
     * get it at once.
     */
    async update(input: {
        dropId: string;
        bundleId: string;
        name?: string | undefined;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
        serialNumbers?: number[] | undefined;
    }): Promise<ArtistDropContentView> {
        const drop = await this.requireDrop(input.dropId);
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        const tier = tierOf(row);
        const serialNumbers = input.serialNumbers === undefined
            ? undefined
            : this.checkSerials(drop, tier, input.serialNumbers, false);
        if (input.isActive === true && !row.isActive) assertNotLocked(row, 'switch it on');

        const updated = await this.deps.drops.update(
            row.id,
            {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            },
            serialNumbers,
            this.now(),
        );
        return this.view(updated);
    }

    /** Removes a tier: nobody can open it. Kept, with its files, so it can be restored. */
    async remove(input: { dropId: string; bundleId: string }): Promise<{ view: ArtistDropContentView; changed: boolean }> {
        const row = await this.requireBundle(input.dropId, input.bundleId);
        if (row.archivedAt) return { view: await this.view(row), changed: false };
        const now = this.now();
        return { view: await this.view(await this.deps.drops.update(row.id, { archivedAt: now }, undefined, now)), changed: true };
    }

    async restore(input: { dropId: string; bundleId: string }): Promise<ArtistDropContentView> {
        const row = await this.requireBundle(input.dropId, input.bundleId);
        if (!row.archivedAt) {
            throw AppError.conflict('This content is not removed.', DROP_CONTENT_ERROR_CODES.NOT_ARCHIVED);
        }
        assertNotLocked(row, 'restore it');
        const now = this.now();
        return this.view(await this.deps.drops.update(row.id, { archivedAt: null }, undefined, now));
    }

    // ── Files ───────────────────────────────────────────────────────────────

    /** Step 1 of adding a file: a presigned URL to PUT it to. */
    async createItemUpload(input: {
        dropId: string;
        bundleId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<RewardUploadTicket & { kind: string }> {
        const media = requireMedia(this.deps.media);
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        assertRoom(row.contentBundleItems.length);
        const kind = assertUploadable(input.mimeType, input.sizeBytes);
        const ticket = await media.createUpload({
            dropId: input.dropId,
            uploadedById: input.uploadedById,
            fileName: input.fileName,
            mimeType: input.mimeType.trim().toLowerCase(),
            sizeBytes: input.sizeBytes,
        });
        return { ...ticket, kind };
    }

    /**
     * Step 2: put the uploaded file into the tier, at the end. Any file
     * uploaded for this drop may go into any of its tiers.
     */
    async addItem(input: {
        dropId: string;
        bundleId: string;
        assetId: string;
        title?: string | null | undefined;
    }): Promise<ArtistDropContentView> {
        const media = requireMedia(this.deps.media);
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        assertRoom(row.contentBundleItems.length);
        if (row.contentBundleItems.some((item) => item.assetId === input.assetId)) throw duplicateFile();

        const [asset] = await media.inspect([input.assetId]);
        assertUsableAsset(asset, input.assetId, (a) => a.dropId === input.dropId, 'it was not uploaded to this drop.');
        try {
            await this.deps.content.addItem({ bundleId: row.id, assetId: input.assetId, title: input.title ?? null, now: this.now() });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateFile();
            throw error;
        }
        return this.get(input.dropId, input.bundleId);
    }

    async updateItem(input: { dropId: string; bundleId: string; itemId: string; title: string | null }): Promise<ArtistDropContentView> {
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        requireItem(row, input.itemId);
        await this.deps.content.updateItemTitle(input.itemId, input.title, row.id, this.now());
        return this.get(input.dropId, input.bundleId);
    }

    async reorderItems(input: { dropId: string; bundleId: string; itemIds: string[] }): Promise<ArtistDropContentView> {
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        assertSameItems(row.contentBundleItems.map((item) => item.id), input.itemIds);
        await this.deps.content.reorderItems(row.id, input.itemIds, this.now());
        return this.get(input.dropId, input.bundleId);
    }

    async removeItem(input: { dropId: string; bundleId: string; itemId: string }): Promise<ArtistDropContentView> {
        const row = await this.requireLiveBundle(input.dropId, input.bundleId);
        requireItem(row, input.itemId);
        await this.deps.content.removeItem(row.id, input.itemId, this.now());
        return this.get(input.dropId, input.bundleId);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Sorted, de-duplicated, within 1…totalSupply. Required (non-empty) for
     * EXCLUSIVE, refused for REGULAR.
     */
    private checkSerials(drop: DropRef, tier: DropContentTier, given: number[] | undefined, creating: boolean): number[] {
        if (tier === 'REGULAR') {
            if (given !== undefined && given.length > 0) {
                throw AppError.badRequest(
                    'Regular content is for every owner of the drop — it takes no serial numbers. Create an exclusive tier for specific units.',
                    DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
                );
            }
            return [];
        }
        const serials = [...new Set(given ?? [])].sort((a, b) => a - b);
        if (serials.length === 0) {
            throw AppError.badRequest(
                creating
                    ? 'Exclusive content needs the serial numbers of the units that open it.'
                    : 'Exclusive content needs at least one unit. Remove the tier instead.',
                DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
            );
        }
        if (serials.length > MAX_SERIALS_PER_TIER) {
            throw AppError.badRequest(
                `An exclusive tier can name at most ${MAX_SERIALS_PER_TIER} units.`,
                DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
                { max: MAX_SERIALS_PER_TIER },
            );
        }
        const outOfRange = serials.filter((n) => !Number.isInteger(n) || n < 1 || n > drop.totalSupply);
        if (outOfRange.length > 0) {
            throw AppError.badRequest(
                `Serial numbers must be between 1 and ${drop.totalSupply} (this drop has ${drop.totalSupply} units).`,
                DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
                { invalid: outOfRange.slice(0, 50), totalSupply: drop.totalSupply },
            );
        }
        return serials;
    }

    private async views(rows: DropContentRow[]): Promise<ArtistDropContentView[]> {
        const ids = rows.map((row) => row.id);
        const [holders, opened] = await Promise.all([
            this.deps.drops.holderCounts(rows.map((row) => ({
                id: row.id,
                dropId: row.productId!,
                tier: tierOf(row),
                serials: serialsOf(row),
            }))),
            this.deps.drops.openedCounts(ids),
        ]);
        return Promise.all(rows.map(async (row) => ({
            id: row.id,
            publicCode: row.publicCode,
            dropId: row.productId!,
            tier: tierOf(row),
            name: row.name,
            description: row.description,
            status: row.archivedAt ? 'REMOVED' as const : row.isActive ? 'ON' as const : 'OFF' as const,
            isActive: row.isActive,
            archivedAt: row.archivedAt?.toISOString() ?? null,
            serialNumbers: serialsOf(row),
            // The artist previews their own files, so they get links.
            items: await itemViews(row.contentBundleItems, this.deps.media, true),
            itemCounts: itemCounts(row.contentBundleItems),
            holders: holders.get(row.id) ?? 0,
            openedBy: opened.get(row.id) ?? 0,
            moderation: {
                locked: row.moderationLockedAt != null,
                reason: row.moderationReason ?? null,
                lockedAt: row.moderationLockedAt?.toISOString() ?? null,
            },
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        })));
    }

    private async view(row: DropContentRow): Promise<ArtistDropContentView> {
        const [view] = await this.views([row]);
        return view!;
    }

    private async requireDrop(dropId: string): Promise<DropRef> {
        const drop = await this.deps.drops.findDrop(dropId);
        if (!drop) throw AppError.notFound('Drop not found.', DROP_CONTENT_ERROR_CODES.DROP_NOT_FOUND);
        return drop;
    }

    private async requireBundle(dropId: string, bundleId: string): Promise<DropContentRow> {
        const row = await this.deps.drops.findForDrop(dropId, bundleId);
        if (!row) throw AppError.notFound('No such content on this drop.', DROP_CONTENT_ERROR_CODES.NOT_FOUND);
        return row;
    }

    private async requireLiveBundle(dropId: string, bundleId: string): Promise<DropContentRow> {
        const row = await this.requireBundle(dropId, bundleId);
        if (row.archivedAt) {
            throw AppError.conflict(
                'This content was removed. Restore it first (POST …/restore).',
                DROP_CONTENT_ERROR_CODES.ARCHIVED,
            );
        }
        return row;
    }
}

function dropRef(drop: DropRef) {
    return { id: drop.id, publicCode: drop.publicCode, name: drop.name, totalSupply: drop.totalSupply };
}

function regularExists(bundleId: string | null): AppError {
    return AppError.conflict(
        'This drop already has its regular content. Edit that one (PATCH …/content/:bundleId), or restore it if it was removed.',
        DROP_CONTENT_ERROR_CODES.REGULAR_EXISTS,
        { bundleId },
    );
}

function requireItem(row: DropContentRow, itemId: string): void {
    if (!row.contentBundleItems.some((item) => item.id === itemId)) {
        throw AppError.notFound('No such file in this content.', CONTENT_ERROR_CODES.ITEM_NOT_FOUND);
    }
}

/** HitBox switched it off or removed it: only HitBox can bring it back. */
function assertNotLocked(row: DropContentRow, what: string): void {
    if (row.moderationLockedAt == null) return;
    throw AppError.conflict(
        `HitBox has locked this content, so you can't ${what}` +
        (row.moderationReason ? `: ${row.moderationReason}` : '.') +
        ' Contact HitBox support to have it reviewed.',
        CONTENT_ERROR_CODES.MODERATION_LOCKED,
        { reason: row.moderationReason },
    );
}
