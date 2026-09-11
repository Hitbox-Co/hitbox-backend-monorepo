/**
 * @hitbox/media
 *
 * The platform's single upload registry. `MediaAsset` is the only table that
 * knows a file exists — products reference assets through `ProductImage`,
 * content bundles through `ContentBundleItem`. Every new feature that touches
 * files goes through here rather than growing a second storage path.
 *
 * File bytes never pass through the API: clients get a presigned PUT and
 * upload straight to the bucket, and only virus-scanned CLEAN assets are ever
 * served back.
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

// The S3 key convention — exported so the scan/thumbnail worker derives the
// same keys instead of re-deriving them from a second copy of the rules.
export {
    ALLOWED_OWNERS,
    OwnerType,
    buildStorageKey,
    derivedKeys,
    extensionOf,
    isOwnerAllowed,
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
export type { MediaScopeCheck } from './service/media.service';

export {
    createUploadUrlSchema,
    listMediaQuerySchema,
    scanResultSchema,
} from './dto/media.dto';
export type { CreateUploadUrlDto, ListMediaQuery, ScanResultDto } from './dto/media.dto';
