import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { MEDIA_CAPABILITY, MEDIA_MODULE } from './constants/media.constant';
import { MediaController } from './controller/media.controller';
import type { MediaCallerResolver } from './controller/media.controller';
import type { IObjectStorage } from './domain/interfaces/object-storage.interface';
import { MediaRepository } from './repository/media.repository';
import { MediaService } from './service/media.service';
import type { ScanPipelineMode } from './service/media.service';

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

    return {
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
