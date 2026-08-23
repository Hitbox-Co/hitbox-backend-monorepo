import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger, env, getRedis } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { AUTHZ_MODULE } from './constants/authz.constant';
import { PermissionCache } from './cache/permission-cache';
import { AuthzController } from './controller/authz.controller';
import { OrganizationController } from './controller/organization.controller';
import { ACTIONS, RESOURCES } from './domain/catalog/resources';
import type { IUserDirectory } from './domain/interfaces/user-directory.interface';
import { createWithAuthz, withSurface } from './middleware/authz-context.middleware';
import { createRequirePermission } from './middleware/require-permission.middleware';
import type { RequirePermission } from './middleware/require-permission.middleware';
import { requireStepUp } from './middleware/step-up.middleware';
import { AuditRepository } from './repository/audit.repository';
import { AuthzRepository } from './repository/authz.repository';
import { OrganizationRepository } from './repository/organization.repository';
import { AuditService } from './service/audit.service';
import { AuthorizationService } from './service/authorization.service';
import { OrganizationService } from './service/organization.service';
import { RoleAssignmentService } from './service/role-assignment.service';

export interface AuthzModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /** Implemented by the users module, injected at bootstrap. */
    users: IUserDirectory;
}

/**
 * Three routers, split by which API SURFACE may reach them. The split is
 * defence in depth: role administration is not merely permission-gated, it is
 * not routable at all from the customer app or the mobile client.
 */
export interface AuthzRouters {
    /**
     * Mounted at /authz on EVERY surface. Read-only, and only ever describes
     * the caller's own access — every frontend needs it to render navigation.
     */
    manifest: Router;
    /**
     * Mounted at /authz on the ADMIN surface only: role administration, the
     * permission catalog and the audit trail.
     */
    admin: Router;
    /** /organizations/* — tenant lifecycle and membership (admin + manage). */
    organizations: Router;
}

export interface AuthzModule {
    /** The central authorization service — inject into any module that needs it. */
    authorization: AuthorizationService;
    roleAssignments: RoleAssignmentService;
    organizations: OrganizationService;
    audit: AuditService;

    /**
     * The route guard every feature module mounts. Handed out by the
     * composition root so no module constructs its own authorization stack.
     */
    requirePermission: RequirePermission;
    /** Attaches req.authz without demanding a specific permission. */
    withAuthz: RequestHandler;
    /** Tags a router tree with the API surface it serves. */
    withSurface: typeof withSurface;
    /** Standalone re-verification gate for non-catalog-driven cases. */
    requireStepUp: RequestHandler;

    createRouters(requireAuth: RequestHandler): AuthzRouters;
    /** Releases the cache's pub/sub connection. Called on shutdown. */
    shutdown(): Promise<void>;
}

export function createAuthzModule(deps: AuthzModuleDeps): AuthzModule {
    const logger = createModuleLogger(AUTHZ_MODULE);

    // ---------------------------------------------------------------- wiring
    const repository = new AuthzRepository(deps.prisma);
    const organizationRepository = new OrganizationRepository(deps.prisma);
    const auditRepository = new AuditRepository(deps.prisma);

    const cache = new PermissionCache({
        redis: getRedis(),
        logger,
        ttlSeconds: env.AUTHZ_CACHE_TTL_SECONDS,
        localTtlMs: env.AUTHZ_LOCAL_CACHE_TTL_MS,
    });

    const audit = new AuditService({ repository: auditRepository, logger });
    const authorization = new AuthorizationService({ repository, cache, logger });

    const roleAssignments = new RoleAssignmentService({
        repository,
        authorization,
        audit,
        users: deps.users,
        eventBus: deps.eventBus,
        logger,
    });

    const organizations = new OrganizationService({
        repository: organizationRepository,
        authorization,
        audit,
        users: deps.users,
        eventBus: deps.eventBus,
        logger,
    });

    // -------------------------------------------------------------- guards
    const requirePermission = createRequirePermission({
        authorization,
        audit,
        logger,
        stepUpMaxAgeMinutes: env.AUTHZ_STEP_UP_MAX_AGE_MINUTES,
    });
    const withAuthz = createWithAuthz({ authorization, logger });

    return {
        authorization,
        roleAssignments,
        organizations,
        audit,
        requirePermission,
        withAuthz,
        withSurface,
        requireStepUp: requireStepUp(env.AUTHZ_STEP_UP_MAX_AGE_MINUTES),

        createRouters(requireAuth) {
            const controller = new AuthzController(
                authorization,
                roleAssignments,
                audit,
                repository,
            );
            const organizationController = new OrganizationController(organizations);

            // -------------------------------------------- /authz (manifest)
            const manifest = Router();

            // Needs no permission beyond being signed in — it only ever
            // describes the caller's own access.
            manifest.get('/me', requireAuth, withAuthz, controller.me);

            // --------------------------------------- /authz (admin surface)
            const authz = Router();

            authz.get(
                '/roles',
                requireAuth,
                requirePermission(RESOURCES.ROLE, ACTIONS.READ),
                controller.listRoles,
            );
            authz.get(
                '/permissions',
                requireAuth,
                requirePermission(RESOURCES.PERMISSION, ACTIONS.READ),
                controller.listPermissions,
            );

            authz.get(
                '/users/:userId/roles',
                requireAuth,
                requirePermission(RESOURCES.ROLE, ACTIONS.READ),
                controller.listUserRoles,
            );
            // role:assign is sensitive in the catalog, so requirePermission also
            // enforces step-up and writes an audit row automatically.
            authz.post(
                '/users/:userId/roles',
                requireAuth,
                requirePermission(RESOURCES.ROLE, ACTIONS.ASSIGN),
                controller.assignRole,
            );
            authz.delete(
                '/users/:userId/roles/:roleKey',
                requireAuth,
                requirePermission(RESOURCES.ROLE, ACTIONS.REVOKE),
                controller.revokeRole,
            );

            authz.get(
                '/audit-logs',
                requireAuth,
                requirePermission(RESOURCES.AUDIT_LOG, ACTIONS.READ),
                controller.listAuditLogs,
            );

            // --------------------------------------------- /organizations
            const organizationRouter = Router();

            organizationRouter.post(
                '/',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION, ACTIONS.CREATE),
                organizationController.create,
            );

            // From here down, :organizationId IS the tenant context — the
            // context middleware picks it up from the route param and refuses
            // non-members, so each handler is already tenant-safe.
            organizationRouter.get(
                '/:organizationId',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION, ACTIONS.READ, {
                    requireOrganization: true,
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.getById,
            );
            organizationRouter.patch(
                '/:organizationId',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION, ACTIONS.UPDATE, {
                    requireOrganization: true,
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.update,
            );
            organizationRouter.delete(
                '/:organizationId',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION, ACTIONS.DELETE, {
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.remove,
            );

            organizationRouter.get(
                '/:organizationId/members',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION_MEMBER, ACTIONS.READ, {
                    requireOrganization: true,
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.listMembers,
            );
            organizationRouter.post(
                '/:organizationId/members',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION_MEMBER, ACTIONS.INVITE, {
                    requireOrganization: true,
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.addMember,
            );
            organizationRouter.delete(
                '/:organizationId/members/:userId',
                requireAuth,
                requirePermission(RESOURCES.ORGANIZATION_MEMBER, ACTIONS.DELETE, {
                    requireOrganization: true,
                    resource: (req) => ({ organizationId: req.params.organizationId ?? null }),
                }),
                organizationController.removeMember,
            );

            return { manifest, admin: authz, organizations: organizationRouter };
        },

        shutdown() {
            return cache.close();
        },
    };
}
