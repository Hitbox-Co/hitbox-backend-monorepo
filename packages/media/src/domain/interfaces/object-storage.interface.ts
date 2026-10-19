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
    /**
     * A time-limited PUT URL for exactly this key, content type and size.
     *
     * `declaredBytes` is bound into the signature as `Content-Length`, so S3
     * rejects a body of any other length. This deployment has **no ingest or
     * scan worker**, which makes the signature the only place an upload's size
     * is enforced at all — so the service requires `sizeBytes` and always
     * passes it. It stays optional on the port only because an S3-compatible
     * backend may not support binding it.
     *
     * `maxBytes` is the policy ceiling, checked by the service before it gets
     * here. A presigned **PUT** cannot express a size *range* (only presigned
     * POST can), so nothing downstream re-checks it. Do not read it as a
     * guarantee enforced by the bucket.
     */
    presignUpload(input: {
        key: string;
        mimeType: string;
        maxBytes: number;
        declaredBytes?: number | undefined;
        expiresInSeconds: number;
    }): Promise<PresignedUpload>;

    /** A short-lived GET URL. Never cached — regenerated per request. */
    presignDownload(input: { key: string; expiresInSeconds: number }): Promise<PresignedUpload>;

    /**
     * The permanent, unsigned URL of an object.
     *
     * Only meaningful for keys under a publicly readable prefix
     * (`isPublicKey`) — for anything else the URL resolves but returns 403,
     * because the bucket policy grants anonymous `s3:GetObject` on
     * `drop-images/*` and `profile-images/*` and nothing else. The service is
     * what decides which keys this may be called for; the adapter just builds
     * the string.
     */
    publicUrl(key: string): string;
}
