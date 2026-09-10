/**
 * @hitbox/access-control
 *
 * Authorization: roles, the system permission catalog, scoped role
 * assignments, and the engine that turns them into ALLOW / DENY.
 *
 * Business modules should need only three things from here:
 *   `guard.requirePermission('order:refund')` on a route,
 *   `guard.authorize(req, 'order:refund', { organizationId })` after a load,
 *   and `req.authz.visibility` to decide how much of a record to reveal.
 *
 * Nothing outside this package should branch on a role name.
 */

// Module factory
export { createAccessControlModule } from './module';
export type { AccessControlModule, AccessControlModuleDeps } from './module';

// Constants
export {
    ACCESS_CONTROL_ERROR_CODES,
    ACCESS_CONTROL_EVENTS,
    ACCESS_CONTROL_MODULE,
} from './constants/access-control.constant';
export type { AccessControlEventName } from './constants/access-control.constant';

// Engine
export { can, decide, effectivePermissionKeys } from './engine/authorization-engine';
export type {
    AccessContext,
    AccessDecision,
    AccessGrantDetail,
    AccessRequest,
} from './engine/authorization-engine';

// Guard
export { createRequirePermission } from './middleware/require-permission.middleware';
export type {
    AccessContextResolver,
    AuthzContext,
    PermissionGuard,
    PrincipalIdResolver,
    RequirePermissionOptions,
} from './middleware/require-permission.middleware';

// Permission catalog (§10 — the authority on what exists)
export {
    ACTION_IMPLIES,
    PERMISSION_CATALOG,
    RESOURCE_DISPLAY,
    RESOURCE_DOMAIN,
    SCOPE_REACH,
    ScopeBreadth,
    ScopeVisibility,
    VISIBILITY_RANK,
    actionSatisfies,
    catalogPermissionsForDomain,
    findCatalogPermission,
    isCatalogPermission,
    permissionGroups,
} from './domain/permission-catalog';
export type {
    CatalogPermission,
    PermissionGroup,
    ScopeReach,
} from './domain/permission-catalog';

// Role catalog
export { ROLE_CATALOG, ROLE_NAMES, findRoleDefinition } from './domain/role-catalog';
export type { EntityGroup, RoleDefinition } from './domain/role-catalog';

// Permission key (de)serialisation
export {
    actionToken,
    formatCapability,
    formatPermissionKey,
    parseCapability,
    parsePermissionKey,
    parsePermissionKeyOrThrow,
    resourceToken,
    scopeToken,
} from './domain/permission-key';
export type { ParsedCapability, ParsedPermissionKey } from './domain/permission-key';

// Caching — three layers: in-process L1, Redis L2, Postgres source of truth
export { LayeredGrantsCache } from './cache/grants-cache';
export type {
    GrantsCacheDeps,
    GrantsCacheOptions,
    GrantsCacheStats,
} from './cache/grants-cache';
export { InProcessStore } from './cache/in-process-store';
export type { InProcessStoreOptions } from './cache/in-process-store';
export { NOOP_GRANTS_INVALIDATOR } from './domain/interfaces/grants-invalidator.interface';
export type { IGrantsInvalidator } from './domain/interfaces/grants-invalidator.interface';
export {
    AUTHZ_CACHE_EPOCH_KEY,
    AUTHZ_CACHE_INVALIDATION_CHANNEL,
    AUTHZ_CACHE_KEY_PREFIX,
    AUTHZ_CACHE_L1_MAX_ENTRIES,
    AUTHZ_CACHE_L1_TTL_MS,
    AUTHZ_CACHE_L2_TTL_SECONDS,
} from './constants/access-control.constant';

// Ports
export type {
    IPrincipalGrantsLookup,
    Principal,
    PrincipalGrant,
} from './domain/interfaces/principal-grants.interface';

// Service response contracts
export type { RoleResponse } from './service/role.service';
export type { AssignmentResponse } from './service/role-assignment.service';

// DTOs
export {
    assignRoleSchema,
    createRoleSchema,
    listPermissionsQuerySchema,
    listRolesQuerySchema,
    revokeRoleQuerySchema,
    updateRoleSchema,
} from './dto/access-control.dto';
export type {
    AssignRoleDto,
    CreateRoleDto,
    ListPermissionsQuery,
    ListRolesQuery,
    UpdateRoleDto,
} from './dto/access-control.dto';

// Seeding
export { seedAccessControl } from './seed/seed-access-control';
export type { SeedResult } from './seed/seed-access-control';
