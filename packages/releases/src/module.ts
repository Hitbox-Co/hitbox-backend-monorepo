import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    RELEASE_DECIDE_CAPABILITY,
    RELEASE_DECISION_CAPABILITIES,
    RELEASE_OVERRIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASE_SUBMIT_CAPABILITY,
    RELEASES_MODULE,
} from './constants/releases.constant';
import { ReleaseGateAdapter } from './domain/release-gate.adapter';
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
    /**
     * Passes when the caller holds any one of these. Needed because the
     * decision route is reached through `approve`, `reject` or `manage`, and
     * nobody entitled to call it holds all three.
     */
    requireAnyPermission(
        capabilities: readonly string[],
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
    /**
     * The publication gate, injected into @hitbox/products so
     * `POST /admin/products/:id/publish` can refuse a drop whose owner has not
     * approved it. Products declares the port; this is the implementation.
     */
    releaseGate: ReleaseGateAdapter;
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
        releaseGate: new ReleaseGateAdapter(releases),

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

            // Submitting is something you do to your OWN drop, so it is gated
            // on the drop capability rather than a release one — and it is not
            // globalOnly, because an org-scoped Brand Admin submits their own.
            router.post(
                '/',
                deps.guard.requirePermission(RELEASE_SUBMIT_CAPABILITY),
                controller.submit,
            );
            // Amending a reviewer's working notes on an open review. Queue
            // administration, hence `manage` rather than the decision set.
            router.patch(
                '/:approvalId',
                deps.guard.requirePermission(RELEASE_DECIDE_CAPABILITY),
                controller.update,
            );
            // The compliance sign-off.
            //
            // Any of approve / reject / manage reaches it, because the owner
            // holds `approve`, an administrator pulling a drop holds `reject`,
            // and whoever administers the queue holds `manage` — no single
            // capability covers everyone entitled to call it. Gating on
            // `manage` alone (as this did) locked ARTIST and BRAND_ADMIN out of
            // approving their own drops entirely.
            //
            // Reaching the route is not being allowed to decide: which party
            // may approve THIS drop is resolved against the loaded row in the
            // service, and a `manage` holder still cannot approve a brand's.
            router.post(
                '/:approvalId/decision',
                deps.guard.requireAnyPermission(RELEASE_DECISION_CAPABILITIES),
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
