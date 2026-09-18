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
import type { IIdentityInvitations } from './domain/interfaces/identity-invitations.interface';
import { UNAVAILABLE_IDENTITY_INVITATIONS } from './domain/interfaces/identity-invitations.interface';
import type { IPrincipalGrantsLookup } from './domain/interfaces/principal-grants.interface';
import { createRequirePermission } from './middleware/require-permission.middleware';
import type {
    PermissionGuard,
    PrincipalIdResolver,
} from './middleware/require-permission.middleware';
import { PermissionRepository } from './repository/permission.repository';
import { RoleAssignmentRepository } from './repository/role-assignment.repository';
import { RoleRepository } from './repository/role.repository';
import { StaffInvitationRepository } from './repository/staff-invitation.repository';
import { UserDirectoryRepository } from './repository/user-directory.repository';
import { PermissionService } from './service/permission.service';
import { RoleAssignmentService } from './service/role-assignment.service';
import { RoleService } from './service/role.service';
import { StaffInvitationService } from './service/staff-invitation.service';

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
    /**
     * Sends staff invitations through the identity provider. Supplied by
     * bootstrap from `@hitbox/auth`. Omitted, the invitation ROUTES still mount
     * and still work for an address that already has an account — only the
     * email path refuses, with a clear message, rather than silently going
     * nowhere.
     */
    identityInvitations?: IIdentityInvitations;
    /** How long a staff invitation stays claimable. Defaults to 72 hours. */
    invitationTtlHours?: number;
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
     * Staff provisioning. Exposed for jobs and scripts: the expiry sweep, and
     * seeding the first administrator on a fresh deployment.
     */
    invitations: StaffInvitationService;
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
    const invitationRepo = new StaffInvitationRepository(deps.prisma);
    const userDirectory = new UserDirectoryRepository(deps.prisma);

    const assignmentService = new RoleAssignmentService({
        assignments: assignmentRepo,
        roles: roleRepo,
        eventBus: deps.eventBus,
        cache: invalidator,
        logger,
    });

    const invitationService = new StaffInvitationService({
        invitations: invitationRepo,
        roles: roleRepo,
        assignments: assignmentService,
        identity: deps.identityInvitations ?? UNAVAILABLE_IDENTITY_INVITATIONS,
        users: userDirectory,
        eventBus: deps.eventBus,
        logger,
        ttlHours: deps.invitationTtlHours ?? 72,
    });

    // Claim a pending invitation the moment the invited person's account
    // exists. Subscribed to the USERS event, not the AUTH one, and that is
    // load-bearing: the bus fires every subscriber of an event concurrently via
    // setImmediate, so listening to the auth event would race the users
    // module's insert and fail this assignment's foreign key intermittently.
    // The users module publishes `users.account.provisioned` AFTER the row is
    // committed, which is the only deterministic signal available.
    deps.eventBus.subscribe<{ userId: string; email: string }>(
        'users.account.provisioned',
        async (payload) => {
            try {
                await invitationService.claimFor(payload);
            } catch (error) {
                logger.error(
                    { err: error, userId: payload.userId },
                    'staff invitation claim failed — the account exists without its role',
                );
            }
        },
    );

    const controller = new AuthzController(
        roleService,
        permissionService,
        assignmentService,
        invitationService,
        guard,
    );

    const { requirePermission } = guard;

    return {
        guard,
        grants,
        invitations: invitationService,

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
            // takes MANAGE rather than ASSIGN — and `globalOnly`, because a
            // role definition applies platform-wide. An org-scoped
            // `employee-role-mgmt:manage:organization` holder (Brand Admin)
            // may grant existing roles inside their organization; they may
            // not author the roles everyone else is granted.
            router.post(
                '/roles',
                requirePermission('employee-role-mgmt:manage', { globalOnly: true }),
                controller.createRole,
            );
            router.patch(
                '/roles/:roleId',
                requirePermission('employee-role-mgmt:manage', { globalOnly: true }),
                controller.updateRole,
            );
            router.delete(
                '/roles/:roleId',
                requirePermission('employee-role-mgmt:manage', { globalOnly: true }),
                controller.deleteRole,
            );

            // The Team screen. Declared before /users/:userId/roles only for
            // readability — the paths do not collide.
            router.get(
                '/team',
                requirePermission('employee-role-mgmt:read'),
                controller.listTeam,
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

            // ── Staff invitations ────────────────────────────────────────────
            //
            // Gated on `employee-role-mgmt:assign` — the SAME capability that
            // gates granting a role directly, because that is exactly what an
            // invitation is: a role assignment that happens later. Making the
            // deferred door weaker than the immediate one would be the whole
            // control undone.
            //
            // The context resolver mirrors the direct assign route, so an
            // ORG-scoped administrator may only invite into their own
            // organization; a platform-wide invitation (organizationId null)
            // needs a grant that reaches beyond one organization.
            router.get(
                '/invitations',
                requirePermission('employee-role-mgmt:read'),
                controller.listInvitations,
            );
            router.post(
                '/invitations',
                requirePermission('employee-role-mgmt:assign', {
                    context: (req) => ({
                        organizationId:
                            (req.body as { organizationId?: string | null } | undefined)
                                ?.organizationId ?? null,
                    }),
                }),
                controller.inviteStaff,
            );
            // Withdrawing an invitation is revoking a grant that has not landed
            // yet, so it takes the delete capability rather than assign.
            router.post(
                '/invitations/:invitationId/revoke',
                requirePermission('employee-role-mgmt:delete'),
                controller.revokeInvitation,
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
