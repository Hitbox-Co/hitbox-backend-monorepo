import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
    IObjectStorage,
    PresignedUpload,
} from '../domain/interfaces/object-storage.interface';

/**
 * S3-backed object storage — the only file in this module that knows about
 * AWS. Everything else talks to `IObjectStorage`, so the registry logic is
 * testable with a fake and swapping in MinIO for local development is a
 * bootstrap change.
 *
 * Credentials are never passed in here. The SDK resolves them from its own
 * chain, which on Railway means the `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` service variables. Keeping them out of this
 * constructor is deliberate: there is no parameter for a secret, so there is
 * nothing for a caller to accidentally log or hardcode.
 *
 * ⚠ NOT YET EXERCISED AGAINST A LIVE BUCKET. The logic around these calls
 * (permission and scope checks, key convention, MIME/size limits, public vs
 * private routing, soft delete) is covered by tests against a fake adapter;
 * the presign calls themselves are standard SDK usage but need one smoke test
 * against the real bucket before first production use — see
 * docs/media/s3-configuration.md §11.
 */
export interface S3ObjectStorageConfig {
    bucket: string;
    region: string;
    /** Set for MinIO or another S3-compatible endpoint. Never set in production. */
    endpoint?: string | undefined;
    forcePathStyle?: boolean | undefined;
    /**
     * Origin that serves the publicly readable prefixes, no trailing slash.
     *
     * Defaults to the bucket's regional S3 endpoint. Exists so putting
     * CloudFront in front of `drop-images/` and `profile-images/` later is one
     * environment variable rather than a code change — every public URL in
     * every API response is built here.
     */
    publicBaseUrl?: string | undefined;
}

export class S3ObjectStorage implements IObjectStorage {
    private readonly client: S3Client;
    private readonly publicBase: string;

    constructor(private readonly config: S3ObjectStorageConfig) {
        this.client = new S3Client({
            region: config.region,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
            ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
        });
        this.publicBase = resolvePublicBase(config);
    }

    async presignUpload(input: {
        key: string;
        mimeType: string;
        maxBytes: number;
        declaredBytes?: number | undefined;
        expiresInSeconds: number;
    }): Promise<PresignedUpload> {
        const command = new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
            // Binding the content type into the signature stops a URL issued
            // for a JPEG being used to upload an executable.
            ContentType: input.mimeType,
            // Bind the exact byte count into the signature so S3 rejects a
            // body of any other length. With no ingest worker in this
            // deployment this is the ONLY enforcement of the size cap, which
            // is why the service requires `sizeBytes` rather than treating it
            // as a hint (see docs/media/s3-configuration.md §9).
            //
            // Both headers end up in X-Amz-SignedHeaders. A browser sets
            // content-length itself from the body — it cannot be set by
            // script — so it matches automatically as long as the file the
            // client PUTs is the one it measured.
            ...(input.declaredBytes !== undefined
                ? { ContentLength: input.declaredBytes }
                : {}),
        });
        const url = await getSignedUrl(this.client, command, {
            expiresIn: input.expiresInSeconds,
        });
        return { url, expiresIn: input.expiresInSeconds };
    }

    async presignDownload(input: {
        key: string;
        expiresInSeconds: number;
    }): Promise<PresignedUpload> {
        const command = new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
        });
        const url = await getSignedUrl(this.client, command, {
            expiresIn: input.expiresInSeconds,
        });
        return { url, expiresIn: input.expiresInSeconds };
    }

    publicUrl(key: string): string {
        // Each segment is encoded individually so the `/` separators survive
        // — encodeURIComponent on the whole key would turn them into %2F and
        // address a different (nonexistent) object.
        const encoded = key.split('/').map(encodeURIComponent).join('/');
        return `${this.publicBase}/${encoded}`;
    }
}

/**
 * Where public objects are served from.
 *
 * Virtual-hosted style (`bucket.s3.region.amazonaws.com`) for real S3;
 * path-style (`endpoint/bucket`) when an endpoint override is set, because
 * that is what MinIO serves. An explicit `publicBaseUrl` wins over both.
 */
function resolvePublicBase(config: S3ObjectStorageConfig): string {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
    if (config.endpoint) {
        return `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`;
    }
    return `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
}
