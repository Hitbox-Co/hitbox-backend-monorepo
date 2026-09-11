import { AssetType } from '@hitbox/database';

export const MEDIA_MODULE = 'media' as const;

export const MEDIA_ERROR_CODES = {
    UNSUPPORTED_MIME_TYPE: 'UNSUPPORTED_MIME_TYPE',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    INVALID_OWNER: 'INVALID_OWNER',
    NOT_FOUND: 'NOT_FOUND',
    FORBIDDEN: 'AUTHZ_FORBIDDEN',
    SCOPE_MISMATCH: 'SCOPE_MISMATCH',
    STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** The capability every media route is gated on. */
export const MEDIA_CAPABILITY = 'assets-documents-upload' as const;

/**
 * Accepted MIME types per asset type, enforced at presign time — before a URL
 * is issued, not after bytes have already landed in the bucket.
 */
export const ALLOWED_MIME_TYPES: Record<AssetType, string[]> = {
    [AssetType.DROP_IMAGE]: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    [AssetType.PROFILE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    [AssetType.EXCLUSIVE_CONTENT]: [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'audio/mpeg', 'application/pdf',
    ],
    [AssetType.LEGAL_DOCUMENT]: ['application/pdf'],
    [AssetType.SUPPLY_SPREADSHEET]: [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [AssetType.OTHER]: [],
};

/** Size caps in bytes, checked before presigning. */
export const MAX_SIZE_BYTES: Record<AssetType, number> = {
    [AssetType.DROP_IMAGE]: 15 * 1024 * 1024,
    [AssetType.PROFILE_IMAGE]: 15 * 1024 * 1024,
    [AssetType.EXCLUSIVE_CONTENT]: 500 * 1024 * 1024,
    [AssetType.LEGAL_DOCUMENT]: 25 * 1024 * 1024,
    [AssetType.SUPPLY_SPREADSHEET]: 25 * 1024 * 1024,
    [AssetType.OTHER]: 25 * 1024 * 1024,
};

/** Presigned PUT lifetime. Long enough for a large upload, short enough that a leaked URL expires. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** Presigned GET lifetime. Regenerated per request, never cached server-side. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export const MEDIA_DEFAULT_LIMIT = 20;
export const MEDIA_MAX_LIMIT = 100;
