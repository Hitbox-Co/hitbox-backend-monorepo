import { AssetType, VirusScanStatus } from '@hitbox/database';
import {
    ALLOWED_OWNERS,
    buildStorageKey,
    derivedKeys,
    extensionOf,
    isOwnerAllowed,
    ownerColumn,
} from '../src/domain/storage-key';
import { MediaService } from '../src/service/media.service';
import type { MediaScopeCheck } from '../src/service/media.service';
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
        virusScanStatus: VirusScanStatus.CLEAN,
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

function makeService(overrides: { asset?: ReturnType<typeof asset> | null } = {}) {
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
    });
    return { service, repository };
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

describe('upload URL', () => {
    it('creates the row PENDING and returns a presigned PUT', async () => {
        const { service, repository } = makeService();
        const result = await service.createUploadUrl({
            dto: {
                assetType: AssetType.DROP_IMAGE, fileName: 'hero.jpg',
                mimeType: 'image/jpeg', ownerType: 'product', ownerId: PRODUCT,
            },
            uploadedById: 'u-1',
            scope: scope(null),
        });

        expect(result.uploadUrl).toBe('https://s3/put');
        expect(result.storageRef).toContain('drop-images/products/');
        expect(repository.create).toHaveBeenCalled();
        expect(storage.presignUpload).toHaveBeenCalledWith(
            expect.objectContaining({ mimeType: 'image/jpeg', expiresInSeconds: 300 }),
        );
    });

    it('rejects a MIME type the asset type does not allow', async () => {
        const { service, repository } = makeService();
        await expect(
            service.createUploadUrl({
                dto: {
                    assetType: AssetType.DROP_IMAGE, fileName: 'x.exe',
                    mimeType: 'application/x-msdownload',
                    ownerType: 'product', ownerId: PRODUCT,
                },
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
                dto: {
                    assetType: AssetType.DROP_IMAGE, fileName: 'huge.jpg',
                    mimeType: 'image/jpeg', ownerType: 'product',
                    ownerId: PRODUCT, sizeBytes: 50 * 1024 * 1024,
                },
                uploadedById: 'u-1',
                scope: scope(null),
            }),
        ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('rejects an owner type the asset type does not accept', async () => {
        const { service } = makeService();
        await expect(
            service.createUploadUrl({
                dto: {
                    assetType: AssetType.LEGAL_DOCUMENT, fileName: 'terms.pdf',
                    mimeType: 'application/pdf', ownerType: 'product', ownerId: PRODUCT,
                },
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
                dto: {
                    assetType: AssetType.DROP_IMAGE, fileName: 'hero.jpg',
                    mimeType: 'image/jpeg', ownerType: 'product', ownerId: PRODUCT,
                },
                uploadedById: 'u-1',
                scope: scope([ORG_B]),
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(repository.create).not.toHaveBeenCalled();
    });

    it('allows an owner inside the caller’s organization', async () => {
        const { service, repository } = makeService();
        await service.createUploadUrl({
            dto: {
                assetType: AssetType.DROP_IMAGE, fileName: 'hero.jpg',
                mimeType: 'image/jpeg', ownerType: 'product', ownerId: PRODUCT,
            },
            uploadedById: 'u-1',
            scope: scope([ORG_A]),
        });
        expect(repository.create).toHaveBeenCalled();
    });
});

describe('serving', () => {
    it('returns a short-lived signed GET for a clean asset', async () => {
        const { service } = makeService();
        const result = await service.signedUrl(ASSET, scope(null));
        expect(result).toEqual({ url: 'https://s3/get', expiresIn: 60 });
    });

    for (const status of [VirusScanStatus.PENDING, VirusScanStatus.INFECTED]) {
        it(`404s a ${status} asset regardless of permission`, async () => {
            // "You may read this" and "this is safe to hand you" are
            // different questions; the scanner answers the second.
            const { service } = makeService({ asset: asset({ virusScanStatus: status }) });
            await expect(service.signedUrl(ASSET, scope(null))).rejects.toMatchObject({
                statusCode: 404,
            });
            expect(storage.presignDownload).not.toHaveBeenCalled();
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
