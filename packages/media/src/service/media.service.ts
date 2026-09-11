import { randomUUID } from 'node:crypto';
import { VirusScanStatus } from '@hitbox/database';
import type { AssetType, MediaAsset } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    ALLOWED_MIME_TYPES,
    DOWNLOAD_URL_TTL_SECONDS,
    MAX_SIZE_BYTES,
    MEDIA_ERROR_CODES,
    UPLOAD_URL_TTL_SECONDS,
} from '../constants/media.constant';
import type { IObjectStorage } from '../domain/interfaces/object-storage.interface';
import { buildStorageKey, isOwnerAllowed, isPublicKey, ownerColumn } from '../domain/storage-key';
import type { OwnerType } from '../domain/storage-key';
import type { CreateUploadUrlDto, ListMediaQuery, ScanResultDto } from '../dto/media.dto';
import type { MediaRepository } from '../repository/media.repository';

/**
 * The upload/serve flow.
 *
 * File bytes never touch the API server: the client gets a presigned PUT and
 * uploads straight to the bucket. That keeps the registry (`MediaAsset`) as
 * the only thing that knows a file exists, and keeps a 500 MB video off the
 * request path.
 *
 *   1. client asks for an upload URL
 *   2. server checks permission at the owner's scope, validates MIME and
 *      size, creates the row, returns a 5-minute presigned PUT
 *   3. client PUTs the bytes straight to S3
 *   4. the asset is servable
 *
 * ── Reading it back depends on the prefix ────────────────────────────────
 *
 * `drop-images/` and `profile-images/` are anonymously readable at the
 * bucket, so their URL is permanent and the client uses it directly — no
 * round trip per render. Everything else (`exclusive-content/`,
 * `legal-documents/`, `supply-spreadsheets/`, `other/`) is private, and
 * `signedUrl` mints a 60-second GET after the same scope check that governs
 * the rest of the module.
 *
 * ── On virus scanning ────────────────────────────────────────────────────
 *
 * This deployment runs no scanner and no ingest worker. `virusScanStatus`
 * survives as a column because the dashboard counts it and existing rows
 * carry it, but with `scanPipeline: 'disabled'` new assets are created
 * `SKIPPED` — the value the schema already reserves for "trusted internal
 * upload that bypassed the scanner" — and `SKIPPED` is servable.
 *
 * Were this left at the original `PENDING`, nothing would ever become
 * servable: `PENDING` returns 404 and only a scan callback clears it. Setting
 * `scanPipeline: 'enabled'` restores the original behaviour exactly, for
 * whenever a scanner is actually wired up.
 */

/** Resolves whether the caller may act on an asset owned by this scope. */
export interface MediaScopeCheck {
    /**
     * Throws (403) when the caller's grant does not reach `organizationId`.
     * Null means the asset is not organization-owned.
     */
    assertScope(organizationId: string | null): void;
    /** Organization ids the caller may read, or null for unrestricted. */
    organizationIds: string[] | null;
}

/**
 * Whether a malware scanner gates serving.
 *
 * `disabled` (this deployment): assets are created `SKIPPED` and are servable
 * immediately. `enabled`: assets are created `PENDING` and stay unservable
 * until a scan callback flips them to `CLEAN`.
 */
export type ScanPipelineMode = 'enabled' | 'disabled';

export interface MediaServiceDeps {
    repository: MediaRepository;
    storage: IObjectStorage;
    logger: Logger;
    /** Bucket name, for the response's absolute-path context only. */
    bucket: string;
    scanPipeline: ScanPipelineMode;
}

/** Statuses that may be served. `SKIPPED` means "no scanner ran, by design". */
const SERVABLE_STATUSES: VirusScanStatus[] = [
    VirusScanStatus.CLEAN,
    VirusScanStatus.SKIPPED,
];

export class MediaService {
    constructor(private readonly deps: MediaServiceDeps) { }

    async createUploadUrl(input: {
        dto: CreateUploadUrlDto;
        uploadedById: string;
        scope: MediaScopeCheck;
    }): Promise<{
        assetId: string;
        uploadUrl: string;
        expiresIn: number;
        storageRef: string;
        bucket: string;
        /** Permanent object URL — non-null only for a publicly readable prefix. */
        publicUrl: string | null;
    }> {
        const { dto } = input;

        if (!isOwnerAllowed(dto.assetType, dto.ownerType)) {
            throw AppError.badRequest(
                `${dto.assetType} cannot be owned by a ${dto.ownerType}.`,
                MEDIA_ERROR_CODES.INVALID_OWNER,
            );
        }

        const allowed = ALLOWED_MIME_TYPES[dto.assetType];
        if (allowed.length > 0 && !allowed.includes(dto.mimeType)) {
            throw AppError.badRequest(
                `${allowed.join(', ')} only for ${dto.assetType}.`,
                MEDIA_ERROR_CODES.UNSUPPORTED_MIME_TYPE,
                { allowed },
            );
        }

        const maxBytes = MAX_SIZE_BYTES[dto.assetType];
        if (dto.sizeBytes > maxBytes) {
            throw AppError.badRequest(
                `Max ${Math.round(maxBytes / (1024 * 1024))}MB for ${dto.assetType}.`,
                MEDIA_ERROR_CODES.FILE_TOO_LARGE,
                { maxBytes },
            );
        }

        // The owner id decides the scope — a client-supplied organization is
        // never trusted, it is checked against what the caller holds.
        const organizationId = await this.resolveOwningOrganization(dto.ownerType, dto.ownerId);
        input.scope.assertScope(organizationId);

        const assetId = randomUUID();
        const storageRef = buildStorageKey({
            assetType: dto.assetType,
            ownerType: dto.ownerType,
            ownerId: dto.ownerId,
            assetId,
            fileName: dto.fileName,
        });

        await this.deps.repository.create({
            id: assetId,
            assetType: dto.assetType,
            storageRef,
            fileName: dto.fileName,
            mimeType: dto.mimeType,
            sizeBytes: dto.sizeBytes,
            uploadedById: input.uploadedById,
            ownerColumn: ownerColumn(dto.ownerType),
            ownerId: dto.ownerId,
            organizationId,
            virusScanStatus: this.initialScanStatus(),
        });

        const presigned = await this.deps.storage.presignUpload({
            key: storageRef,
            mimeType: dto.mimeType,
            maxBytes,
            declaredBytes: dto.sizeBytes,
            expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
        });

        this.deps.logger.info(
            { assetId, assetType: dto.assetType, ownerType: dto.ownerType, storageRef },
            'media upload url issued',
        );

        return {
            assetId,
            uploadUrl: presigned.url,
            expiresIn: presigned.expiresIn,
            storageRef,
            bucket: this.deps.bucket,
            // Handed back at upload time so the caller can persist the image
            // URL immediately rather than round-tripping for it after the PUT.
            publicUrl: this.publicUrlFor(storageRef),
        };
    }

    async list(query: ListMediaQuery, scope: MediaScopeCheck) {
        const { total, items } = await this.deps.repository.list({
            ...query,
            organizationIds: scope.organizationIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        const byType = await this.deps.repository.countByType(scope.organizationIds);
        const byScanStatus = await this.deps.repository.countByScanStatus(scope.organizationIds);
        return {
            page: query.page,
            limit: query.limit,
            total,
            byType,
            byScanStatus,
            items: items.map((item) => toResponse(item, this.publicUrlFor(item.storageRef))),
        };
    }

    /**
     * A URL for reading the asset.
     *
     * Public prefixes return their permanent object URL with
     * `expiresIn: null` — signing one would be theatre, since the same bytes
     * are readable anonymously at that address anyway. Private prefixes get a
     * 60-second presigned GET.
     *
     * The scope check runs either way. It governs who may *learn the address*
     * of a public object (an unpublished drop's artwork is anonymously
     * readable only by someone who already has the URL), and who may read a
     * private one at all.
     *
     * Out-of-scope, archived, missing and not-yet-servable all return the
     * **same** 404. A distinct 403 would confirm the asset exists, which is
     * enough to enumerate other organizations' uploads by id.
     */
    async signedUrl(
        assetId: string,
        scope: MediaScopeCheck,
    ): Promise<{ url: string; expiresIn: number | null; public: boolean }> {
        const asset = await this.deps.repository.findById(assetId);

        const unavailable =
            !asset ||
            asset.archivedAt !== null ||
            !SERVABLE_STATUSES.includes(asset.virusScanStatus) ||
            !this.inScope(asset, scope);

        if (unavailable) {
            throw AppError.notFound('Asset not found.', MEDIA_ERROR_CODES.NOT_FOUND);
        }

        if (isPublicKey(asset.storageRef)) {
            return {
                url: this.deps.storage.publicUrl(asset.storageRef),
                expiresIn: null,
                public: true,
            };
        }

        const presigned = await this.deps.storage.presignDownload({
            key: asset.storageRef,
            expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
        });
        return { url: presigned.url, expiresIn: presigned.expiresIn, public: false };
    }

    /**
     * Soft delete. The row and the object both stay — `MediaAsset` is an
     * append-only registry, and a hard delete would break every
     * `ProductImage` / `ContentBundleItem` that references it.
     */
    async archive(
        assetId: string,
        scope: MediaScopeCheck,
    ): Promise<{ assetId: string; archivedAt: string }> {
        const asset = await this.deps.repository.findById(assetId);
        if (!asset || !this.inScope(asset, scope)) {
            throw AppError.notFound('Asset not found.', MEDIA_ERROR_CODES.NOT_FOUND);
        }
        const archived = await this.deps.repository.archive(assetId);
        this.deps.logger.info({ assetId }, 'media asset archived');
        return {
            assetId,
            archivedAt: (archived.archivedAt ?? new Date()).toISOString(),
        };
    }

    /** Called by the scan pipeline once the object has been checked. */
    async recordScanResult(dto: ScanResultDto): Promise<MediaAsset> {
        const updated = await this.deps.repository.setScanResult(dto);
        this.deps.logger.info(
            { assetId: dto.assetId, status: dto.virusScanStatus },
            'media scan result recorded',
        );
        return updated;
    }

    /**
     * `SKIPPED` when nothing will ever scan this file, `PENDING` when
     * something will. Creating rows `PENDING` with no scanner attached is the
     * failure mode this guards against — they would never become servable.
     */
    private initialScanStatus(): VirusScanStatus {
        return this.deps.scanPipeline === 'enabled'
            ? VirusScanStatus.PENDING
            : VirusScanStatus.SKIPPED;
    }

    /** The permanent URL, or null when the key is not anonymously readable. */
    private publicUrlFor(storageRef: string): string | null {
        return isPublicKey(storageRef) ? this.deps.storage.publicUrl(storageRef) : null;
    }

    private inScope(asset: MediaAsset, scope: MediaScopeCheck): boolean {
        if (scope.organizationIds === null) return true;
        if (asset.organizationId === null) return false;
        return scope.organizationIds.includes(asset.organizationId);
    }

    /**
     * The organization that owns an asset, derived from the owner record —
     * never from the request body.
     */
    private async resolveOwningOrganization(
        ownerType: OwnerType,
        ownerId: string,
    ): Promise<string | null> {
        switch (ownerType) {
            case 'organization':
                return ownerId;
            case 'product':
                return this.deps.repository.organizationOfProduct(ownerId);
            case 'collection':
                return this.deps.repository.organizationOfCollection(ownerId);
            case 'artist':
                return this.deps.repository.organizationOfArtist(ownerId);
            default:
                // user / vendor uploads are not organization-owned.
                return null;
        }
    }
}

function toResponse(asset: MediaAsset, publicUrl: string | null) {
    return {
        assetId: asset.id,
        assetType: asset.assetType,
        fileName: asset.fileName,
        storageRef: asset.storageRef,
        // Present for drop-images/profile-images, null for every private
        // prefix — those need GET /:assetId/url per read.
        publicUrl,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        virusScanStatus: asset.virusScanStatus,
        productId: asset.productId,
        collectionId: asset.collectionId,
        organizationId: asset.organizationId,
        artistId: asset.artistId,
        uploadedById: asset.uploadedById,
        archivedAt: asset.archivedAt?.toISOString() ?? null,
        createdAt: asset.createdAt.toISOString(),
    };
}

export type { AssetType };
