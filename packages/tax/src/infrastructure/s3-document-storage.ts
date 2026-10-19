import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isTaxKey } from '../domain/document-storage-key';
import type {
    IDocumentStorage,
    PresignedDownload,
    StoredDocument,
} from '../domain/interfaces/document-storage.port';

/**
 * S3-backed storage for tax documents — the only file in this module that
 * knows about AWS.
 *
 * It intentionally does not reuse `@hitbox/media`'s `S3ObjectStorage`. That
 * class presigns PUT URLs for a browser to upload through; this one writes
 * server-produced bytes directly and never issues a write URL to anybody. They
 * point at the same bucket and share nothing else, which is the right amount of
 * sharing: a change to how user uploads are signed must not be able to change
 * how an invoice is stored.
 *
 * Credentials are never passed in here. The SDK resolves them from its own
 * chain — on Railway, the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` service
 * variables. There is no constructor parameter for a secret, so there is
 * nothing for a caller to log or hardcode. Same rule `@hitbox/media` follows.
 *
 * See docs/tax/s3-storage.md for the bucket layout, the lifecycle rules and the
 * IAM policy these keys assume.
 */
export interface S3DocumentStorageConfig {
    bucket: string;
    region: string;
    /** Set for MinIO or another S3-compatible endpoint. Never in production. */
    endpoint?: string | undefined;
    forcePathStyle?: boolean | undefined;
    /**
     * SSE-KMS key id. Optional: the bucket's default encryption already covers
     * these objects, and setting a key here is for the case where tax documents
     * need a *separate* key from the rest of the bucket — which is a reasonable
     * thing to want for W-9s and is one env var away.
     */
    kmsKeyId?: string | undefined;
}

export class S3DocumentStorage implements IDocumentStorage {
    private readonly client: S3Client;

    constructor(private readonly config: S3DocumentStorageConfig) {
        this.client = new S3Client({
            region: config.region,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
            ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
        });
    }

    async put(input: {
        key: string;
        body: Buffer;
        contentType: string;
        metadata?: Record<string, string>;
    }): Promise<StoredDocument> {
        // A key outside this module's prefixes means a caller built one by
        // hand. Refusing here is cheap and stops a tax document ever landing
        // under `drop-images/`, which is anonymously readable.
        assertTaxKey(input.key);

        const sha256 = createHash('sha256').update(input.body).digest('hex');

        await this.client.send(
            new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: input.key,
                Body: input.body,
                ContentType: input.contentType,
                // Bound into the request so S3 rejects a body that does not
                // hash to this — the object in the bucket is provably the
                // document we rendered, which is the whole point of storing
                // the digest on the invoice row.
                ChecksumSHA256: input.body.length > 0
                    ? createHash('sha256').update(input.body).digest('base64')
                    : undefined,
                ...(this.config.kmsKeyId
                    ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: this.config.kmsKeyId }
                    : {}),
                ...(input.metadata ? { Metadata: input.metadata } : {}),
                // No ACL. Every key here is private at the bucket; an explicit
                // public-read would be the one line that undoes that.
            }),
        );

        return { key: input.key, sha256, byteSize: input.body.length };
    }

    async presignDownload(input: {
        key: string;
        expiresInSeconds: number;
    }): Promise<PresignedDownload> {
        assertTaxKey(input.key);
        const url = await getSignedUrl(
            this.client,
            new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
            { expiresIn: input.expiresInSeconds },
        );
        return { url, expiresIn: input.expiresInSeconds };
    }

    async get(key: string): Promise<Buffer> {
        assertTaxKey(key);
        const result = await this.client.send(
            new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        );
        const bytes = await result.Body?.transformToByteArray();
        if (!bytes) throw new Error(`Object has no body: ${key}`);
        return Buffer.from(bytes);
    }
}

function assertTaxKey(key: string): void {
    if (!isTaxKey(key)) {
        throw new Error(
            `Refusing to touch "${key}": tax documents live under tax-invoices/, ` +
            `tax-filings/ or tax-artist-documents/ only.`,
        );
    }
}
