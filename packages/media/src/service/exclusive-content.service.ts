import { AssetType } from '@hitbox/database';
import { EXCLUSIVE_VIEW_URL_TTL_SECONDS } from '../constants/media.constant';
import type { IObjectStorage } from '../domain/interfaces/object-storage.interface';
import type { MediaRepository } from '../repository/media.repository';
import type { MediaService } from './media.service';
import { SERVABLE_STATUSES } from './media.service';

export interface ExclusiveContentUpload {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    /** Headers the PUT must carry — bound into the signature. */
    requiredHeaders: { 'Content-Type': string };
}

/** What the content module is told about a file before adding it to a reward. */
export interface ExclusiveContentAsset {
    id: string;
    /** The collection the upload URL was issued for (a collection reward). */
    collectionId: string | null;
    /** The drop the upload URL was issued for (drop content). */
    dropId: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    uploadedById: string;
    archived: boolean;
    infected: boolean;
    /** The bytes are in the bucket at the size that was declared. */
    uploaded: boolean;
}

/** A signed, time-limited link to one private file. `url` is null when it cannot be served. */
export interface ExclusiveContentLink {
    assetId: string;
    url: string | null;
    expiresIn: number | null;
}

/**
 * Exclusive content — the files behind a collection reward or a drop's
 * content. The provider side of the content module's `IRewardMedia` port.
 *
 * Files live under `exclusive-content/collections/{collectionId}/…` or
 * `exclusive-content/products/{dropId}/…`, a private prefix: there is no
 * public URL, ever. Every view is a short-lived
 * signed GET, issued only after the content module has decided the caller may
 * see the reward.
 *
 * No permission check happens here, on purpose — the same arrangement as
 * return evidence and artist images. The caller (content, behind the artist
 * module's ownership check, or behind the buyer's unlock) has already decided
 * *who* may act; media's job is the file rules: type, MIME, size, key layout,
 * and whether the bytes really arrived.
 */
export class ExclusiveContentService {
    constructor(
        private readonly deps: {
            media: MediaService;
            repository: MediaRepository;
            storage: IObjectStorage;
        },
    ) { }

    /** Exactly one of `collectionId` (collection reward) or `dropId` (drop content). */
    async createUpload(input: {
        collectionId?: string | undefined;
        dropId?: string | undefined;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ExclusiveContentUpload> {
        const owner = input.dropId
            ? { ownerType: 'product' as const, ownerId: input.dropId }
            : input.collectionId
                ? { ownerType: 'collection' as const, ownerId: input.collectionId }
                : null;
        if (!owner) throw new Error('exclusive content upload needs a collectionId or a dropId');
        const result = await this.deps.media.createUploadUrl({
            dto: {
                assetType: AssetType.EXCLUSIVE_CONTENT,
                ...owner,
                fileName: input.fileName,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
            },
            uploadedById: input.uploadedById,
            // Ownership was proven by the artist module before content called.
            scope: { organizationIds: null, assertScope: () => undefined },
        });
        return {
            assetId: result.assetId,
            uploadUrl: result.uploadUrl,
            expiresIn: result.expiresIn,
            requiredHeaders: { 'Content-Type': input.mimeType },
        };
    }

    /**
     * Facts about each id that is an exclusive-content asset. Ids that are
     * missing, or are some other kind of asset, are absent from the answer.
     * One HEAD per live asset, in parallel — bounded by the reward's item cap.
     */
    async inspect(assetIds: string[]): Promise<ExclusiveContentAsset[]> {
        if (assetIds.length === 0) return [];
        const rows = (await this.deps.repository.findManyByIds(assetIds)).filter(
            (row) => row.assetType === AssetType.EXCLUSIVE_CONTENT,
        );
        return Promise.all(
            rows.map(async (row) => {
                const head = row.archivedAt === null
                    ? await this.deps.storage.headObject(row.storageRef)
                    : null;
                return {
                    id: row.id,
                    collectionId: row.collectionId,
                    dropId: row.productId,
                    fileName: row.fileName,
                    mimeType: row.mimeType,
                    sizeBytes: row.sizeBytes,
                    uploadedById: row.uploadedById,
                    archived: row.archivedAt !== null,
                    infected: row.virusScanStatus === 'INFECTED',
                    uploaded:
                        head !== null && (row.sizeBytes === null || head.sizeBytes === row.sizeBytes),
                };
            }),
        );
    }

    /**
     * Signed GETs, in the order asked for. An archived or unservable file keeps
     * its place with a null URL, so a reward never silently shrinks.
     *
     * An hour, not the minute other downloads get: a video or a track is
     * streamed with range requests for as long as it plays, and each request
     * is checked against the signature.
     */
    async links(assetIds: string[]): Promise<ExclusiveContentLink[]> {
        if (assetIds.length === 0) return [];
        const rows = await this.deps.repository.findManyByIds(assetIds);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const links: ExclusiveContentLink[] = [];
        for (const assetId of assetIds) {
            const row = byId.get(assetId);
            const servable =
                row !== undefined &&
                row.assetType === AssetType.EXCLUSIVE_CONTENT &&
                row.archivedAt === null &&
                SERVABLE_STATUSES.includes(row.virusScanStatus);
            const signed = servable
                ? await this.deps.storage.presignDownload({
                    key: row!.storageRef,
                    expiresInSeconds: EXCLUSIVE_VIEW_URL_TTL_SECONDS,
                })
                : null;
            links.push({ assetId, url: signed?.url ?? null, expiresIn: signed?.expiresIn ?? null });
        }
        return links;
    }
}
