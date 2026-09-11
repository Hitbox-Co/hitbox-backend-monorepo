/**
 * @hitbox/media
 *
 * The platform's single upload registry. `MediaAsset` is the only table that
 * knows a file exists — products reference assets through `ProductImage`,
 * content bundles through `ContentBundleItem`. Every new feature that touches
 * files goes through here rather than growing a second storage path.
 *
 * File bytes never pass through the API: clients get a presigned PUT and
 * upload straight to the bucket.
 *
 * Reading back splits on the key's prefix. `drop-images/` and
 * `profile-images/` are anonymously readable at the bucket, so the API hands
 * out a permanent object URL for them. Every other prefix is private and
 * reachable only through a short-lived presigned GET issued after a
 * permission check. See docs/media/s3-configuration.md.
 */

export { createMediaModule } from './module';
export type { MediaModule, MediaModuleDeps, MediaPermissionGuard } from './module';

export {
    ALLOWED_MIME_TYPES,
    DOWNLOAD_URL_TTL_SECONDS,
    MAX_SIZE_BYTES,
    MEDIA_CAPABILITY,
    MEDIA_ERROR_CODES,
    MEDIA_MODULE,
    UPLOAD_URL_TTL_SECONDS,
} from './constants/media.constant';

// The S3 key convention, plus which prefixes the bucket policy makes public —
// exported so anything deriving a URL uses these rules rather than a second
// copy of them.
export {
    ALLOWED_OWNERS,
    OwnerType,
    PUBLIC_ASSET_TYPES,
    PUBLIC_PREFIXES,
    buildStorageKey,
    derivedKeys,
    extensionOf,
    isOwnerAllowed,
    isPublicKey,
    ownerColumn,
} from './domain/storage-key';

// Storage port + the S3 adapter.
export type {
    IObjectStorage,
    PresignedUpload,
} from './domain/interfaces/object-storage.interface';
export { S3ObjectStorage } from './infrastructure/s3-object-storage';
export type { S3ObjectStorageConfig } from './infrastructure/s3-object-storage';

export type { MediaCallerResolver } from './controller/media.controller';
export type { MediaScopeCheck, ScanPipelineMode } from './service/media.service';

export {
    createUploadUrlSchema,
    listMediaQuerySchema,
    scanResultSchema,
} from './dto/media.dto';
export type { CreateUploadUrlDto, ListMediaQuery, ScanResultDto } from './dto/media.dto';
