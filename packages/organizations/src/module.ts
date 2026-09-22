import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { ORGANIZATION_READ_CAPABILITY } from './constants/organizations.constant';
import { OrganizationController } from './controller/organization.controller';
import { OrganizationRepository } from './repository/organization.repository';
import { OrganizationService } from './service/organization.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface OrganizationsPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface OrganizationsModuleDeps {
    prisma: PrismaClient;
    guard: OrganizationsPermissionGuard;
}

export interface OrganizationsModule {
    /** Mounted at /api/v1/admin/organizations. */
    createRouter(requireAuth: RequestHandler): Router;
}

/**
 * The organization directory.
 *
 * Read-only for now. Creating and editing organizations is an onboarding
 * workflow (legal entity, payout details, compliance attestation) that has no
 * screen yet; this module exists because the drop form needs a brand picker
 * and the catalog needs to label rows with an owner.
 */
export function createOrganizationsModule(
    deps: OrganizationsModuleDeps,
): OrganizationsModule {
    const organizations = new OrganizationRepository(deps.prisma);
    const service = new OrganizationService({ organizations });
    const controller = new OrganizationController(service);

    return {
        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            router.get(
                '/',
                deps.guard.requirePermission(ORGANIZATION_READ_CAPABILITY),
                controller.list,
            );
            router.get(
                '/:organizationId',
                deps.guard.requirePermission(ORGANIZATION_READ_CAPABILITY),
                controller.getById,
            );

            return router;
        },
    };
}
