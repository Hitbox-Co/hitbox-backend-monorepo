import { AssetType } from '@hitbox/database';
import { EVIDENCE_VIEW_URL_TTL_SECONDS } from '../constants/media.constant';
import type { IObjectStorage } from '../domain/interfaces/object-storage.interface';
import { orderOfEvidenceKey } from '../domain/storage-key';
import type { MediaRepository } from '../repository/media.repository';
import type { MediaService } from './media.service';
import { SERVABLE_STATUSES } from './media.service';

export interface ReturnEvidenceUpload {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    /** Headers the PUT must carry — both are bound into the signature. */
    requiredHeaders: { 'Content-Type': string };
}

/** What the payments module is told about a photo before attaching it. */
export interface ReturnEvidenceAsset {
    id: string;
    /** The order the upload URL was issued for, read from the key. */
    orderId: string | null;
    uploadedById: string;
    archived: boolean;
    /** The scanner found malware. Never true while scanning is disabled. */
    infected: boolean;
    /** The bytes are in the bucket at the size that was declared. */
    uploaded: boolean;
}

/** A photo as shown on a refund. `url` is null when it cannot be served. */
export interface ReturnEvidenceFile {
    assetId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    url: string | null;
    expiresIn: number | null;
}

/**
 * The provider side of payments' `IReturnEvidenceMedia` port.
 *
 * No permission check happens here, on purpose — the same arrangement as
 * artist profile images. The payments module has already proven the caller
 * owns the order (or holds the refund grant) before it asks; media's job is
 * the file rules: type, MIME, size, key layout, and whether the bytes really
 * arrived.
 */
export class ReturnEvidenceService {
    constructor(
        private readonly deps: {
            media: MediaService;
            repository: MediaRepository;
            storage: IObjectStorage;
        },
    ) { }

    async createUpload(input: {
        orderId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ReturnEvidenceUpload> {
        const result = await this.deps.media.createUploadUrl({
            dto: {
                assetType: AssetType.RETURN_EVIDENCE,
                ownerType: 'order',
                ownerId: input.orderId,
                fileName: input.fileName,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
            },
            uploadedById: input.uploadedById,
            // Ownership was proven by the caller. An `order` owner resolves to
            // no organization, so these assets are also invisible to every
            // organization-scoped media reader — a brand never sees a buyer's
            // photos through the media library.
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
     * Facts about each id that is a return-evidence asset. Ids that are
     * missing, or are some other kind of asset, are simply absent — the
     * caller reports them as not found, which is all a buyer needs to know.
     *
     * One HEAD per asset, in parallel. Bounded by the caller's photo limit.
     */
    async inspect(assetIds: string[]): Promise<ReturnEvidenceAsset[]> {
        if (assetIds.length === 0) return [];
        const rows = (await this.deps.repository.findManyByIds(assetIds)).filter(
            (row) => row.assetType === AssetType.RETURN_EVIDENCE,
        );
        return Promise.all(
            rows.map(async (row) => {
                const head = row.archivedAt === null
                    ? await this.deps.storage.headObject(row.storageRef)
                    : null;
                return {
                    id: row.id,
                    orderId: orderOfEvidenceKey(row.storageRef),
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
     * Signed GETs for the photos on a refund, in the order asked for.
     *
     * A photo that was archived or failed a scan stays in the list with a null
     * URL rather than disappearing: an operator deciding a return should see
     * that the buyer sent three photos and one cannot be shown, not wonder why
     * the count changed.
     */
    async viewFiles(assetIds: string[]): Promise<ReturnEvidenceFile[]> {
        if (assetIds.length === 0) return [];
        const rows = await this.deps.repository.findManyByIds(assetIds);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const files: ReturnEvidenceFile[] = [];
        for (const assetId of assetIds) {
            const row = byId.get(assetId);
            if (!row) continue;
            const servable = row.archivedAt === null && SERVABLE_STATUSES.includes(row.virusScanStatus);
            const signed = servable
                ? await this.deps.storage.presignDownload({
                    key: row.storageRef,
                    expiresInSeconds: EVIDENCE_VIEW_URL_TTL_SECONDS,
                })
                : null;
            files.push({
                assetId: row.id,
                fileName: row.fileName,
                mimeType: row.mimeType,
                sizeBytes: row.sizeBytes,
                url: signed?.url ?? null,
                expiresIn: signed?.expiresIn ?? null,
            });
        }
        return files;
    }
}
