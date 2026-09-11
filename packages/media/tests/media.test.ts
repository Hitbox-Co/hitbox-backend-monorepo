import { AssetType, VirusScanStatus } from '@hitbox/database';
import {
    ALLOWED_OWNERS,
    buildStorageKey,
    derivedKeys,
    extensionOf,
    isOwnerAllowed,
    isPublicKey,
    ownerColumn,
} from '../src/domain/storage-key';
import { S3ObjectStorage } from '../src/infrastructure/s3-object-storage';
import { MediaService } from '../src/service/media.service';
import type { MediaScopeCheck, ScanPipelineMode } from '../src/service/media.service';
import { AppError } from '@hitbox/shared';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PRODUCT = 'p-3333';
const ASSET = 'a-4444';

const logger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} as unknown as Parameters<typeof MediaService.prototype.constructor>[0]['logger'];

/** Fake storage — the presign calls are the only thing S3 would do. */
const storage = {
    presignUpload: jest.fn().mockResolvedValue({ url: 'https://s3/put', expiresIn: 300 }),
    presignDownload: jest.fn().mockResolvedValue({ url: 'https://s3/get', expiresIn: 60 }),
    publicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
};

function scope(organizationIds: string[] | null): MediaScopeCheck {
    return {
        organizationIds,
        assertScope(organizationId) {
            if (organizationIds === null) return;
            if (organizationId === null || !organizationIds.includes(organizationId)) {
                throw AppError.forbidden('out of scope', 'SCOPE_MISMATCH');
            }
        },
    };
}

function asset(overrides: Record<string, unknown> = {}) {
    return {
        id: ASSET,
        assetType: AssetType.DROP_IMAGE,
        storageRef: `drop-images/products/${PRODUCT}/${ASSET}.jpg`,
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        checksum: null,
        virusScanStatus: VirusScanStatus.SKIPPED,
        uploadedById: 'u-1',
        organizationId: ORG_A,
        artistId: null,
        productId: PRODUCT,
        collectionId: null,
        archivedAt: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        ...overrides,
    };
}

function makeService(
    overrides: {
        asset?: ReturnType<typeof asset> | null;
        scanPipeline?: ScanPipelineMode;
    } = {},
) {
    const repository = {
        create: jest.fn().mockImplementation(async (input) => asset({ id: input.id })),
        findById: jest.fn().mockResolvedValue('asset' in overrides ? overrides.asset : asset()),
        list: jest.fn().mockResolvedValue({ total: 0, items: [] }),
        countByType: jest.fn().mockResolvedValue({}),
        countByScanStatus: jest.fn().mockResolvedValue({}),
        archive: jest.fn().mockResolvedValue(asset({ archivedAt: new Date() })),
        setScanResult: jest.fn().mockResolvedValue(asset()),
        organizationOfProduct: jest.fn().mockResolvedValue(ORG_A),
        organizationOfCollection: jest.fn().mockResolvedValue(ORG_A),
        organizationOfArtist: jest.fn().mockResolvedValue(ORG_A),
    };
    const service = new MediaService({
        repository: repository as never,
        storage,
        logger,
        bucket: 'hitbox-media-test',
        scanPipeline: overrides.scanPipeline ?? 'disabled',
    });
    return { service, repository };
}

/** A valid upload request; individual tests override the field under test. */
function uploadDto(overrides: Record<string, unknown> = {}) {
    return {
        assetType: AssetType.DROP_IMAGE,
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
        ownerType: 'product' as const,
        ownerId: PRODUCT,
        sizeBytes: 1000,
        ...overrides,
    };
}

beforeEach(() => jest.clearAllMocks());

// ────────────────────────────────────────────────────────────────────────────

describe('S3 key convention', () => {
    it('files each asset type under its own top-level prefix', () => {
        expect(
            buildStorageKey({
                assetType: AssetType.DROP_IMAGE, ownerType: 'product',
                ownerId: PRODUCT, assetId: ASSET, fileName: 'hero.jpg',
            }),
        ).toBe(`drop-images/products/${PRODUCT}/${ASSET}.jpg`);

        expect(
            buildStorageKey({
                assetType: AssetType.LEGAL_DOCUMENT, ownerType: 'organization',
                ownerId: ORG_A, assetId: ASSET, fileName: 'terms.pdf',
            }),
        ).toBe(`legal-documents/organizations/${ORG_A}/${ASSET}.pdf`);
    });

    it('uses the asset id as the filename, never the uploaded name', () => {
        // Keeps path traversal, invalid S3 characters and filename-based
        // information leakage out of a user-supplied string.
        const key = buildStorageKey({
            assetType: AssetType.DROP_IMAGE, ownerType: 'product',
            ownerId: PRODUCT, assetId: ASSET, fileName: '../../etc/passwd.jpg',
        });
        expect(key).toBe(`drop-images/products/${PRODUCT}/${ASSET}.jpg`);
        expect(key).not.toContain('..');
        expect(key).not.toContain('passwd');
    });

    it('keeps only a safe extension', () => {
        expect(extensionOf('a.JPG')).toBe('jpg');
        expect(extensionOf('no-extension')).toBe('bin');
        expect(extensionOf('weird.sh!')).toBe('bin');
        expect(extensionOf('x.')).toBe('bin');
    });

    it('puts derived sizes beside the original', () => {
        expect(derivedKeys(`drop-images/products/${PRODUCT}/${ASSET}.jpg`)).toEqual({
            thumb: `drop-images/products/${PRODUCT}/${ASSET}-thumb.jpg`,
            card: `drop-images/products/${PRODUCT}/${ASSET}-card.jpg`,
        });
    });

    it('restricts which owners each asset type accepts', () => {
        expect(isOwnerAllowed(AssetType.DROP_IMAGE, 'product')).toBe(true);
        // A legal document filed under a product would be invisible to the
        // organization-scoped IAM policy meant to protect it.
        expect(isOwnerAllowed(AssetType.LEGAL_DOCUMENT, 'product')).toBe(false);
        expect(isOwnerAllowed(AssetType.PROFILE_IMAGE, 'organization')).toBe(false);
        expect(ALLOWED_OWNERS[AssetType.SUPPLY_SPREADSHEET]).toEqual(['vendor']);
    });

    it('maps owner types to the right MediaAsset column', () => {
        expect(ownerColumn('product')).toBe('productId');
        expect(ownerColumn('organization')).toBe('organizationId');
        // A user upload is already attributed by uploadedById.
        expect(ownerColumn('user')).toBeNull();
    });
});

describe('public vs private prefixes', () => {
    // This block and the bucket policy's Resource list in
    // docs/media/s3-configuration.md §4 are the same fact written twice.
    // If they drift, either images stop loading or a legal document is
    // published — so every asset type is pinned to a side here.

    it('treats exactly drop-images and profile-images as public', () => {
        expect(isPublicKey('drop-images/products/p-1/a-1.jpg')).toBe(true);
        expect(isPublicKey('profile-images/users/u-1/a-1.png')).toBe(true);
        expect(isPublicKey('profile-images/artists/ar-1/a-1.png')).toBe(true);
    });

    it('keeps every sensitive prefix private', () => {
        expect(isPublicKey('exclusive-content/products/p-1/a-1.mp4')).toBe(false);
        expect(isPublicKey('legal-documents/organizations/o-1/a-1.pdf')).toBe(false);
        expect(isPublicKey('supply-spreadsheets/vendors/v-1/a-1.csv')).toBe(false);
        expect(isPublicKey('other/users/u-1/a-1.bin')).toBe(false);
    });

    it('is not fooled by a public prefix appearing mid-key', () => {
        // A prefix match, not a substring match — the bucket policy matches
        // on prefix too, so anything else would disagree with it.
        expect(isPublicKey('legal-documents/organizations/drop-images/a.pdf')).toBe(false);
        expect(isPublicKey('other/drop-images/x/a-1.jpg')).toBe(false);
    });

    it('every asset type lands on the intended side', () => {
        const publicTypes = [AssetType.DROP_IMAGE, AssetType.PROFILE_IMAGE];
        for (const assetType of Object.values(AssetType)) {
            const ownerType = ALLOWED_OWNERS[assetType][0] as 'product';
            const key = buildStorageKey({
                assetType, ownerType, ownerId: 'o-1', assetId: ASSET, fileName: 'f.bin',
            });
            expect(isPublicKey(key)).toBe(publicTypes.includes(assetType));
        }
    });
});

describe('public URL construction', () => {
    it('uses the virtual-hosted regional S3 endpoint by default', () => {
        const s3 = new S3ObjectStorage({ bucket: 'hitbox-media-prod', region: 'ap-south-1' });
        expect(s3.publicUrl('drop-images/products/p-1/a-1.jpg')).toBe(
            'https://hitbox-media-prod.s3.ap-south-1.amazonaws.com/drop-images/products/p-1/a-1.jpg',
        );
    });

    it('honours an explicit public base (a CDN in front of the images)', () => {
        const s3 = new S3ObjectStorage({
            bucket: 'hitbox-media-prod',
            region: 'ap-south-1',
            publicBaseUrl: 'https://cdn.hitbox.example/',
        });
        expect(s3.publicUrl('drop-images/p.jpg')).toBe('https://cdn.hitbox.example/drop-images/p.jpg');
    });

    it('uses path style against an S3-compatible endpoint (MinIO)', () => {
        const s3 = new S3ObjectStorage({
            bucket: 'hitbox-media-dev',
            region: 'us-east-1',
            endpoint: 'http://localhost:9000',
        });
        expect(s3.publicUrl('drop-images/p.jpg')).toBe(
            'http://localhost:9000/hitbox-media-dev/drop-images/p.jpg',
        );
    });

    it('encodes each segment without destroying the separators', () => {
        // encodeURIComponent over the whole key would turn / into %2F and
        // address a different, nonexistent object.
        const s3 = new S3ObjectStorage({ bucket: 'b', region: 'ap-south-1' });
        expect(s3.publicUrl('drop-images/products/p 1/a.jpg')).toBe(
            'https://b.s3.ap-south-1.amazonaws.com/drop-images/products/p%201/a.jpg',
        );
    });
});

describe('upload URL', () => {
    it('returns a presigned PUT and binds the declared length into it', async () => {
        const { service, repository } = makeService();
        const result = await service.createUploadUrl({
            dto: uploadDto({ sizeBytes: 482113 }),
            uploadedById: 'u-1',
            scope: scope(null),
        });

        expect(result.uploadUrl).toBe('https://s3/put');
        expect(result.storageRef).toContain('drop-images/products/');
        expect(repository.create).toHaveBeenCalled();
        // declaredBytes is what makes S3 reject a body of any other size —
        // with no ingest worker it is the only size enforcement there is.
        expect(storage.presignUpload).toHaveBeenCalledWith(
            expect.objectContaining({
                mimeType: 'image/jpeg',
                declaredBytes: 482113,
                expiresInSeconds: 300,
            }),
        );
    });

    it('creates the row SKIPPED when no scanner is deployed', async () => {
        // PENDING here would be a permanent 404: nothing would ever clear it.
        const { service, repository } = makeService();
        await service.createUploadUrl({
            dto: uploadDto(),
            uploadedById: 'u-1',
            scope: scope(null),
        });
        expect(repository.create).toHaveBeenCalledWith(
            expect.objectContaining({ virusScanStatus: VirusScanStatus.SKIPPED }),
        );
    });

    it('creates the row PENDING when a scan pipeline is enabled', async () => {
        const { service, repository } = makeService({ scanPipeline: 'enabled' });
        await service.createUploadUrl({
            dto: uploadDto(),
            uploadedById: 'u-1',
            scope: scope(null),
        });
        expect(repository.create).toHaveBeenCalledWith(
            expect.objectContaining({ virusScanStatus: VirusScanStatus.PENDING }),
        );
    });

    it('returns a permanent public URL for a public prefix', async () => {
        const { service } = makeService();
        const result = await service.createUploadUrl({
            dto: uploadDto(),
            uploadedById: 'u-1',
            scope: scope(null),
        });
        expect(result.publicUrl).toContain('drop-images/products/');
    });

    it('returns no public URL for a private prefix', async () => {
        const { service } = makeService();
        const result = await service.createUploadUrl({
            dto: uploadDto({
                assetType: AssetType.LEGAL_DOCUMENT,
                fileName: 'terms.pdf',
                mimeType: 'application/pdf',
                ownerType: 'organization',
                ownerId: ORG_A,
            }),
            uploadedById: 'u-1',
            scope: scope(null),
        });
        expect(result.storageRef).toContain('legal-documents/');
        expect(result.publicUrl).toBeNull();
    });

    it('rejects a MIME type the asset type does not allow', async () => {
        const { service, repository } = makeService();
        await expect(
            service.createUploadUrl({
                dto: uploadDto({
                    fileName: 'x.exe',
                    mimeType: 'application/x-msdownload',
                }),
                uploadedById: 'u-1',
                scope: scope(null),
            }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_MIME_TYPE' });
        // Rejected before a row or a URL exists.
        expect(repository.create).not.toHaveBeenCalled();
        expect(storage.presignUpload).not.toHaveBeenCalled();
    });

    it('rejects an oversized file before issuing a URL', async () => {
        const { service } = makeService();
        await expect(
            service.createUploadUrl({
                dto: uploadDto({ fileName: 'huge.jpg', sizeBytes: 50 * 1024 * 1024 }),
                uploadedById: 'u-1',
                scope: scope(null),
            }),
        ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('rejects an owner type the asset type does not accept', async () => {
        const { service } = makeService();
        await expect(
            service.createUploadUrl({
                dto: uploadDto({
                    assetType: AssetType.LEGAL_DOCUMENT,
                    fileName: 'terms.pdf',
                    mimeType: 'application/pdf',
                }),
                uploadedById: 'u-1',
                scope: scope(null),
            }),
        ).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    });

    it("refuses an owner outside the caller's organization", async () => {
        // The owning org comes from the product record, not the request —
        // so claiming a different organizationId in the body changes nothing.
        const { service, repository } = makeService();
        await expect(
            service.createUploadUrl({
                dto: uploadDto(),
                uploadedById: 'u-1',
                scope: scope([ORG_B]),
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(repository.create).not.toHaveBeenCalled();
    });

    it('allows an owner inside the caller’s organization', async () => {
        const { service, repository } = makeService();
        await service.createUploadUrl({
            dto: uploadDto(),
            uploadedById: 'u-1',
            scope: scope([ORG_A]),
        });
        expect(repository.create).toHaveBeenCalled();
    });
});

describe('serving', () => {
    it('returns the permanent object URL for a public prefix', async () => {
        // drop-images/ is anonymously readable at the bucket, so signing it
        // would be theatre — the same bytes are reachable at that address.
        const { service } = makeService();
        const result = await service.signedUrl(ASSET, scope(null));
        expect(result).toEqual({
            url: `https://cdn.test/drop-images/products/${PRODUCT}/${ASSET}.jpg`,
            expiresIn: null,
            public: true,
        });
        expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it('returns a short-lived signed GET for a private prefix', async () => {
        const { service } = makeService({
            asset: asset({
                assetType: AssetType.LEGAL_DOCUMENT,
                storageRef: `legal-documents/organizations/${ORG_A}/${ASSET}.pdf`,
            }),
        });
        const result = await service.signedUrl(ASSET, scope(null));
        expect(result).toEqual({ url: 'https://s3/get', expiresIn: 60, public: false });
        expect(storage.publicUrl).not.toHaveBeenCalled();
    });

    for (const status of [VirusScanStatus.CLEAN, VirusScanStatus.SKIPPED]) {
        it(`serves a ${status} asset`, async () => {
            const { service } = makeService({ asset: asset({ virusScanStatus: status }) });
            await expect(service.signedUrl(ASSET, scope(null))).resolves.toMatchObject({
                public: true,
            });
        });
    }

    for (const status of [VirusScanStatus.PENDING, VirusScanStatus.INFECTED]) {
        it(`404s a ${status} asset regardless of permission`, async () => {
            // Only reachable on a deploy that once ran a scanner, or on rows
            // predating this one — but the gate stays, because INFECTED must
            // never be servable and PENDING means nothing has vouched for it.
            const { service } = makeService({ asset: asset({ virusScanStatus: status }) });
            await expect(service.signedUrl(ASSET, scope(null))).rejects.toMatchObject({
                statusCode: 404,
            });
            expect(storage.presignDownload).not.toHaveBeenCalled();
            expect(storage.publicUrl).not.toHaveBeenCalled();
        });
    }

    it('404s an archived asset', async () => {
        const { service } = makeService({ asset: asset({ archivedAt: new Date() }) });
        await expect(service.signedUrl(ASSET, scope(null))).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('404s — not 403 — an asset outside the caller’s scope', async () => {
        // A distinct 403 would confirm the asset exists, which is enough to
        // enumerate another organization's uploads by id.
        const { service } = makeService();
        const error = await service.signedUrl(ASSET, scope([ORG_B])).catch((e) => e);
        expect(error.statusCode).toBe(404);
        expect(error.code).toBe('NOT_FOUND');
    });

    it('404s a missing asset with the identical response', async () => {
        const { service } = makeService({ asset: null });
        const error = await service.signedUrl('nope', scope(null)).catch((e) => e);
        expect(error.statusCode).toBe(404);
        expect(error.code).toBe('NOT_FOUND');
    });
});

describe('archive', () => {
    it('soft deletes, leaving the row and the object in place', async () => {
        const { service, repository } = makeService();
        const result = await service.archive(ASSET, scope(null));
        expect(repository.archive).toHaveBeenCalledWith(ASSET);
        expect(result.archivedAt).toBeDefined();
    });

    it('refuses an asset outside scope', async () => {
        const { service, repository } = makeService();
        await expect(service.archive(ASSET, scope([ORG_B]))).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(repository.archive).not.toHaveBeenCalled();
    });
});

describe('scan callback', () => {
    it('records the scanner verdict', async () => {
        const { service, repository } = makeService();
        await service.recordScanResult({
            assetId: ASSET,
            virusScanStatus: VirusScanStatus.CLEAN,
            checksum: 'abc123',
        });
        expect(repository.setScanResult).toHaveBeenCalledWith(
            expect.objectContaining({ virusScanStatus: VirusScanStatus.CLEAN }),
        );
    });
});
