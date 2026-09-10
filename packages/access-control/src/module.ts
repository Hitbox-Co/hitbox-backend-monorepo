import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { LayeredGrantsCache } from './cache/grants-cache';
import type { GrantsCacheOptions, GrantsCacheStats } from './cache/grants-cache';
import { ACCESS_CONTROL_MODULE } from './constants/access-control.constant';
import { AuthzController } from './controller/authz.controller';
import type { IGrantsInvalidator } from './domain/interfaces/grants-invalidator.interface';
import { NOOP_GRANTS_INVALIDATOR } from './domain/interfaces/grants-invalidator.interface';
import type { IPrincipalGrantsLookup } from './domain/interfaces/principal-grants.interface';
import { createRequirePermission } from './middleware/require-permission.middleware';
import type {
    PermissionGuard,
    PrincipalIdResolver,
} from './middleware/require-permission.middleware';
import { PermissionRepository } from './repository/permission.repository';
import { RoleAssignmentRepository } from './repository/role-assignment.repository';
import { RoleRepository } from './repository/role.repository';
import { PermissionService } from './service/permission.service';
import { RoleAssignmentService } from './service/role-assignment.service';
import { RoleService } from './service/role.service';

export interface AccessControlModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    /**
     * Adapter that reads the authenticated account id off a request. Supplied
     * by bootstrap (`req => req.auth?.accountId`) so this module stays
     * independent of the authentication provider.
     */
    resolvePrincipalId: PrincipalIdResolver;
    /**
     * Grant caching. Omit for the default three-layer cache
     * (in-process → Redis → Postgres). Pass `false` to read straight from the
     * database on every check — useful in tests and for debugging an
     * authorization decision without cache interference.
     */
    cache?: false | GrantsCacheOptions;
}

export interface AccessControlModule {
    /**
     * The guard every other module mounts on its routes. Exported as a
     * capability, so business modules depend on `requirePermission('x:y')`
     * and never on this module's internals or on any role name.
     */
    guard: PermissionGuard;
    /** Port other modules/services can read grants through. */
    grants: IPrincipalGrantsLookup;
    /** Generic authorization administration, mounted under /admin/authz. */
    createAdminRouter(requireAuth: RequestHandler): Router;
    /** GET /authz/me — the caller's own effective permissions. */
    createSelfRouter(requireAuth: RequestHandler): Router;
    /** Mirrors the code catalog into the permissions table. */
    syncPermissionCatalog(): Promise<{ created: number; updated: number; deactivated: number }>;
    /**
     * Subscribes the in-process cache to cross-instance invalidation
     * broadcasts. Call once after bootstrap; no-ops when caching is disabled
     * or REDIS_URL is unset.
     */
    startCache(): Promise<void>;
    /** Releases the pub/sub connection. Call on graceful shutdown. */
    stopCache(): Promise<void>;
    /** Per-layer hit/miss counters, or null when caching is disabled. */
    cacheStats(): GrantsCacheStats | null;
}

export function createAccessControlModule(
    deps: AccessControlModuleDeps,
): AccessControlModule {
    const logger = createModuleLogger(ACCESS_CONTROL_MODULE);

    const permissionRepo = new PermissionRepository(deps.prisma);
    const roleRepo = new RoleRepository(deps.prisma);
    const assignmentRepo = new RoleAssignmentRepository(deps.prisma);

    // The cache decorates the repository rather than living inside it: the
    // repository stays a pure Postgres reader, and the engine is handed one
    // IPrincipalGrantsLookup either way and never learns which it got.
    const grantsCache =
        deps.cache === false
            ? null
            : new LayeredGrantsCache({
                source: assignmentRepo,
                logger,
                ...(deps.cache ? { options: deps.cache } : {}),
            });

    const grants: IPrincipalGrantsLookup = grantsCache ?? assignmentRepo;
    const invalidator: IGrantsInvalidator = grantsCache ?? NOOP_GRANTS_INVALIDATOR;

    const guard = createRequirePermission({
        grants,
        resolvePrincipalId: deps.resolvePrincipalId,
    });

    const roleService = new RoleService({
        roles: roleRepo,
        permissions: permissionRepo,
        eventBus: deps.eventBus,
        cache: invalidator,
        logger,
    });
    const permissionService = new PermissionService();
    const assignmentService = new RoleAssignmentService({
        assignments: assignmentRepo,
        roles: roleRepo,
        eventBus: deps.eventBus,
        cache: invalidator,
        logger,
    });

    const controller = new AuthzController(
        roleService,
        permissionService,
        assignmentService,
        guard,
    );

    const { requirePermission } = guard;

    return {
        guard,
        grants,

        createAdminRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            // Every route is guarded by a capability, never a role name. Any
            // role holding employee-role-mgmt:read passes — today that is
            // HITBOX_SYSTEM_ADMIN globally and BRAND_ADMIN within its own
            // organization, and tomorrow whatever an operator defines.
            router.get(
                '/permissions',
                requirePermission('employee-role-mgmt:read'),
                controller.listPermissions,
            );

            router.get(
                '/roles',
                requirePermission('employee-role-mgmt:read'),
                controller.listRoles,
            );
            router.get(
                '/roles/:roleId',
                requirePermission('employee-role-mgmt:read'),
                controller.getRole,
            );
            // Defining roles is strictly stronger than assigning them, so it
            // takes MANAGE rather than ASSIGN.
            router.post(
                '/roles',
                requirePermission('employee-role-mgmt:manage'),
                controller.createRole,
            );
            router.patch(
                '/roles/:roleId',
                requirePermission('employee-role-mgmt:manage'),
                controller.updateRole,
            );
            router.delete(
                '/roles/:roleId',
                requirePermission('employee-role-mgmt:manage'),
                controller.deleteRole,
            );

            router.get(
                '/users/:userId/roles',
                requirePermission('employee-role-mgmt:read'),
                controller.listUserRoles,
            );
            // An ORG-scoped assigner (Brand Admin) may only grant inside its
            // own organization: the engine compares the assignment's
            // organization to the one in the request body.
            router.post(
                '/users/:userId/roles',
                requirePermission('employee-role-mgmt:assign', {
                    context: (req) => ({
                        organizationId:
                            (req.body as { organizationId?: string | null } | undefined)
                                ?.organizationId ?? null,
                    }),
                }),
                controller.assignRole,
            );
            router.delete(
                '/users/:userId/roles/:roleId',
                requirePermission('employee-role-mgmt:delete', {
                    context: (req) => ({
                        organizationId: (req.query.organizationId as string | undefined) ?? null,
                    }),
                }),
                controller.revokeRole,
            );

            return router;
        },

        createSelfRouter(requireAuth) {
            const router = Router();
            router.get('/me', requireAuth, controller.me);
            return router;
        },

        async syncPermissionCatalog() {
            const result = await permissionRepo.syncCatalog();
            // Deactivating a retired permission changes what its holders can
            // do, so a sync that touched anything must flush.
            if (result.created || result.updated || result.deactivated) {
                await invalidator.invalidateAll('permission catalog synced');
            }
            return result;
        },

        startCache() {
            return grantsCache?.start() ?? Promise.resolve();
        },

        stopCache() {
            return grantsCache?.stop() ?? Promise.resolve();
        },

        cacheStats() {
            return grantsCache?.stats() ?? null;
        },
    };
}
