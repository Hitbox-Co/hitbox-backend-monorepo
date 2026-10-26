import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { AssetType } from '@hitbox/database';
import { MEDIA_CAPABILITY, MEDIA_MODULE } from './constants/media.constant';
import { isPublicKey } from './domain/storage-key';
import { MediaController } from './controller/media.controller';
import type { MediaCallerResolver } from './controller/media.controller';
import type { IObjectStorage } from './domain/interfaces/object-storage.interface';
import { MediaRepository } from './repository/media.repository';
import type { AssetRef } from './repository/media.repository';
import { MediaService } from './service/media.service';
import type { ScanPipelineMode } from './service/media.service';
import { ReturnEvidenceService } from './service/return-evidence.service';
import type {
    ReturnEvidenceAsset,
    ReturnEvidenceFile,
    ReturnEvidenceUpload,
} from './service/return-evidence.service';

/**
 * Structural guard — the shape of `requirePermission`, not an import of the
 * authorization module. Bootstrap passes the real one.
 */
export interface MediaPermissionGuard {
    requirePermission(
        capability: string,
        options?: {
            context?: (
                req: Request,
            ) =>
                | { organizationId?: string | null; ownerId?: string | null }
                | Promise<{ organizationId?: string | null; ownerId?: string | null }>;
        },
    ): RequestHandler;
}

export interface MediaModuleDeps {
    prisma: PrismaClient;
    guard: MediaPermissionGuard;
    resolveCaller: MediaCallerResolver;
    /** The storage backend. Inject `S3ObjectStorage` in production. */
    storage: IObjectStorage;
    bucket: string;
    /**
     * Whether a malware scanner gates serving. Defaults to `'disabled'`,
     * which matches the deployed architecture: no SQS, no scan worker, no
     * callback. Assets are created `SKIPPED` and are servable straight away.
     *
     * Set `'enabled'` **only** alongside `scanCallback` — enabling it without
     * a callback creates assets as `PENDING` that nothing will ever clear,
     * and every one of them 404s forever.
     */
    scanPipeline?: ScanPipelineMode;
    /**
     * Authenticates the scan pipeline's callback. Omit and the scan-result
     * route is not mounted at all.
     *
     * Not supplied in this deployment, so `POST /scan-result` does not exist.
     * The handler behind it is kept rather than deleted: it is the only thing
     * that would need to be re-wired if scanning is ever introduced, and it
     * is unreachable in the meantime.
     *
     * Same reasoning as the audit module's export gate: a route that flips an
     * asset to CLEAN is a route that makes files servable, so it must not be
     * reachable by forgetting to configure its auth. Making the gate the thing
     * that mounts the route means there is no ungated version to forget.
     */
    scanCallback?: { authenticate: RequestHandler };
}

export interface MediaModule {
    createRouter(requireAuth: RequestHandler): Router;
    /**
     * Asset lookup for modules that join `MediaAsset` into their own tables —
     * today the products gallery. Media owns the table, so media answers
     * "does this asset exist, is it an image, is it archived" rather than
     * letting a consumer query it directly.
     */
    assets: IAssetLookup;
    /**
     * Artist profile images (avatar / cover). The provider side of the
     * artist module's `IArtistImageStorage` port.
     *
     * The artist module has already proven the caller owns the artist before
     * it calls this, so no organization scope is applied here — an artist
     * uploads to their own profile, not to an organization's media library.
     */
    profileImages: IArtistProfileImages;
    /**
     * Buyer photos on a return. The provider side of the payments module's
     * `IReturnEvidenceMedia` port — payments proves the caller owns the order,
     * media applies the file rules and checks the bytes really arrived.
     */
    returnEvidence: IReturnEvidenceMedia;
}

export interface IReturnEvidenceMedia {
    createUpload(input: {
        orderId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ReturnEvidenceUpload>;
    inspect(assetIds: string[]): Promise<ReturnEvidenceAsset[]>;
    viewFiles(assetIds: string[]): Promise<ReturnEvidenceFile[]>;
}

export interface ArtistImageUpload {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    publicUrl: string | null;
}

export interface ArtistImageAsset {
    id: string;
    assetType: string;
    mimeType: string;
    artistId: string | null;
    archived: boolean;
    virusScanStatus: string;
    /** Permanent URL — profile-images/ is publicly readable. */
    publicUrl: string | null;
}

export interface IArtistProfileImages {
    createUpload(input: {
        artistId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ArtistImageUpload>;
    findAsset(assetId: string): Promise<ArtistImageAsset | null>;
}

/** The provider side of products' `IMediaAssets` port. */
export interface IAssetLookup {
    findByIds(ids: string[]): Promise<AssetRef[]>;
}

export function createMediaModule(deps: MediaModuleDeps): MediaModule {
    const logger = createModuleLogger(MEDIA_MODULE);
    const repository = new MediaRepository(deps.prisma);
    const service = new MediaService({
        repository,
        storage: deps.storage,
        logger,
        bucket: deps.bucket,
        scanPipeline: deps.scanPipeline ?? 'disabled',
    });
    const controller = new MediaController(service, deps.resolveCaller);
    const returnEvidence = new ReturnEvidenceService({
        media: service,
        repository,
        storage: deps.storage,
    });

    return {
        assets: { findByIds: (ids) => repository.findManyByIds(ids) },

        returnEvidence: {
            createUpload: (input) => returnEvidence.createUpload(input),
            inspect: (ids) => returnEvidence.inspect(ids),
            viewFiles: (ids) => returnEvidence.viewFiles(ids),
        },

        profileImages: {
            async createUpload(input) {
                const result = await service.createUploadUrl({
                    dto: {
                        assetType: AssetType.PROFILE_IMAGE,
                        ownerType: 'artist',
                        ownerId: input.artistId,
                        fileName: input.fileName,
                        mimeType: input.mimeType,
                        sizeBytes: input.sizeBytes,
                    },
                    uploadedById: input.uploadedById,
                    // Ownership was proven by the artist module (the caller's
                    // user is this artist's user). Same type, mime and size
                    // rules as every other upload still apply inside.
                    scope: { organizationIds: null, assertScope: () => undefined },
                });
                return {
                    assetId: result.assetId,
                    uploadUrl: result.uploadUrl,
                    expiresIn: result.expiresIn,
                    publicUrl: result.publicUrl,
                };
            },
            async findAsset(assetId) {
                const [row] = await repository.findManyByIds([assetId]);
                if (!row) return null;
                return {
                    id: row.id,
                    assetType: row.assetType,
                    mimeType: row.mimeType,
                    artistId: row.artistId,
                    archived: row.archivedAt !== null,
                    virusScanStatus: row.virusScanStatus,
                    publicUrl: isPublicKey(row.storageRef) ? deps.storage.publicUrl(row.storageRef) : null,
                };
            },
        },

        createRouter(requireAuth) {
            const router = Router();

            // The scan callback is machine-to-machine: it carries its own
            // authentication and must be mounted before requireAuth, which
            // expects a human session.
            if (deps.scanCallback) {
                router.post(
                    '/scan-result',
                    deps.scanCallback.authenticate,
                    controller.scanResult,
                );
            }

            router.use(requireAuth);

            // One capability for the whole surface; the scope inside it is
            // what separates a brand uploading to its own products from
            // HitBox staff uploading anywhere.
            router.post(
                '/upload-url',
                deps.guard.requirePermission(`${MEDIA_CAPABILITY}:create`),
                controller.createUploadUrl,
            );
            router.get(
                '/',
                deps.guard.requirePermission(`${MEDIA_CAPABILITY}:read`),
                controller.list,
            );
            router.get(
                '/:assetId/url',
                deps.guard.requirePermission(`${MEDIA_CAPABILITY}:read`),
                controller.signedUrl,
            );
            router.delete(
                '/:assetId',
                deps.guard.requirePermission(`${MEDIA_CAPABILITY}:delete`),
                controller.archive,
            );

            return router;
        },
    };
}
