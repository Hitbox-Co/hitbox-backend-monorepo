/**
 * Object storage, as this module needs it.
 *
 * Deliberately NOT `@hitbox/media`'s `IObjectStorage`. That port presigns an
 * upload URL for a *browser* to PUT to, which is the right shape for a user
 * uploading an image and the wrong shape entirely for a tax document: the
 * invoice PDF is produced by the server, from server-side data, and never
 * passes through a client. A presign step here would mean handing out a URL
 * that lets someone else write the invoice.
 *
 * So this port puts bytes directly and returns only a key, and the only URL it
 * ever issues is a short-lived **GET** — after a permission check, per request,
 * never cached.
 *
 * A port rather than a direct S3 call so the invoice pipeline — numbering, tax
 * arithmetic, rendering, integrity hashing — is testable without a bucket.
 */
export interface StoredDocument {
    /** The S3 key the object was written to. Never a URL. */
    key: string;
    /** SHA-256 of the bytes written, lowercase hex. Integrity evidence. */
    sha256: string;
    byteSize: number;
}

export interface PresignedDownload {
    url: string;
    expiresIn: number;
}

export interface IDocumentStorage {
    /**
     * Writes an object and returns its key and digest.
     *
     * Implementations must set a content type and must NOT set any public-read
     * ACL — every key this module produces is private at the bucket (see
     * domain/document-storage-key.ts).
     */
    put(input: {
        key: string;
        body: Buffer;
        contentType: string;
        /**
         * Retention class for the bucket's lifecycle rules to key off, when the
         * backend supports object tagging. Advisory: the authoritative
         * lifecycle configuration is on the prefix, not the object.
         */
        metadata?: Record<string, string>;
    }): Promise<StoredDocument>;

    /** A short-lived GET URL. Never cached — regenerated per request. */
    presignDownload(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload>;

    /** The raw bytes, for re-serving through the API rather than redirecting. */
    get(key: string): Promise<Buffer>;
}
