import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    RELEASE_DECIDE_CAPABILITY,
    RELEASE_OVERRIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASES_MODULE,
} from './constants/releases.constant';
import { NOOP_RELEASE_AUDIT } from './domain/interfaces/release-audit.interface';
import type { IReleaseAudit } from './domain/interfaces/release-audit.interface';
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
    /**
     * The compliance trail. Defaults to a no-op so tests need not wire the
     * audit module — but a running server must pass the real recorder, or
     * every approval happens unrecorded, which looks identical to nothing
     * happening.
     */
    audit?: IReleaseAudit | undefined;
}

export interface ReleasesModule {
    createRouter(requireAuth: RequestHandler): Router;
}

export function createReleasesModule(deps: ReleasesModuleDeps): ReleasesModule {
    const logger = createModuleLogger(RELEASES_MODULE);
    const releases = new ReleaseRepository(deps.prisma);
    const service = new ReleaseService({
        releases,
        eventBus: deps.eventBus,
        logger,
        audit: deps.audit ?? NOOP_RELEASE_AUDIT,
    });
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

            // Sending a decided review back to its owner. Gated on override
            // rather than decide: it is an administrator overruling an outcome,
            // not a party signing one off.
            router.post(
                '/:approvalId/reopen',
                deps.guard.requirePermission(RELEASE_OVERRIDE_CAPABILITY),
                controller.reopen,
            );

            return router;
        },
    };
}
