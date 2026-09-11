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
 * ⚠ NOT EXERCISED AGAINST A LIVE BUCKET. The environment this was written in
 * has no AWS credentials, bucket or region configured. The logic around it
 * (permission and scope checks, key convention, MIME/size limits, scan
 * gating, soft delete) is covered by tests against a fake adapter; these two
 * presign calls are standard SDK usage but need one smoke test against a real
 * bucket before first production use.
 */
export interface S3ObjectStorageConfig {
    bucket: string;
    region: string;
    /** Set for MinIO or another S3-compatible endpoint. */
    endpoint?: string | undefined;
    forcePathStyle?: boolean | undefined;
}

export class S3ObjectStorage implements IObjectStorage {
    private readonly client: S3Client;

    constructor(private readonly config: S3ObjectStorageConfig) {
        this.client = new S3Client({
            region: config.region,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
            ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
        });
    }

    async presignUpload(input: {
        key: string;
        mimeType: string;
        maxBytes: number;
        expiresInSeconds: number;
    }): Promise<PresignedUpload> {
        const command = new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
            // Binding the content type into the signature stops a URL issued
            // for a JPEG being used to upload an executable.
            ContentType: input.mimeType,
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
}
