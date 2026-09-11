/**
 * Object storage, as this module needs it.
 *
 * A port rather than a direct S3 call so the registry logic — permissions,
 * key convention, scan gating, soft delete — is testable without a bucket,
 * and so a different backend (MinIO in dev, another cloud later) is a
 * bootstrap change rather than a rewrite.
 */
export interface PresignedUpload {
    url: string;
    expiresIn: number;
}

export interface IObjectStorage {
    /** A time-limited PUT URL for exactly this key, type and size. */
    presignUpload(input: {
        key: string;
        mimeType: string;
        maxBytes: number;
        expiresInSeconds: number;
    }): Promise<PresignedUpload>;

    /** A short-lived GET URL. Never cached — regenerated per request. */
    presignDownload(input: { key: string; expiresInSeconds: number }): Promise<PresignedUpload>;
}
