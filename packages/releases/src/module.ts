import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    RELEASE_DECIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASES_MODULE,
} from './constants/releases.constant';
import { ReleaseController } from './controller/release.controller';
import type { ReleaseCallerResolver } from './controller/release.controller';
import { ReleaseRepository } from './repository/release.repository';
import { ReleaseService } from './service/release.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface ReleasesPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface ReleasesModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: ReleasesPermissionGuard;
    resolveCaller: ReleaseCallerResolver;
}

export interface ReleasesModule {
    createRouter(requireAuth: RequestHandler): Router;
}

export function createReleasesModule(deps: ReleasesModuleDeps): ReleasesModule {
    const logger = createModuleLogger(RELEASES_MODULE);
    const releases = new ReleaseRepository(deps.prisma);
    const service = new ReleaseService({ releases, eventBus: deps.eventBus, logger });
    const controller = new ReleaseController(service, deps.resolveCaller);

    return {
        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            router.get(
                '/',
                deps.guard.requirePermission(RELEASE_READ_CAPABILITY),
                controller.list,
            );
            router.get(
                '/:approvalId',
                deps.guard.requirePermission(RELEASE_READ_CAPABILITY),
                controller.getById,
            );

            // Submitting a drop for review is a brand action — an org-scoped
            // Brand Admin submits their own drops — so it is not globalOnly.
            router.post(
                '/',
                deps.guard.requirePermission(RELEASE_DECIDE_CAPABILITY),
                controller.submit,
            );
            router.patch(
                '/:approvalId',
                deps.guard.requirePermission(RELEASE_DECIDE_CAPABILITY),
                controller.update,
            );
            // Deciding is the compliance sign-off. The service additionally
            // requires the override capability to reverse a recorded decision.
            router.post(
                '/:approvalId/decision',
                deps.guard.requirePermission(RELEASE_DECIDE_CAPABILITY),
                controller.decide,
            );

            return router;
        },
    };
}
