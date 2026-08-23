// ============================================================================
// @hitbox/authz — the platform's AUTHORIZATION module.
//
// Authentication ("who is this?") lives in @hitbox/auth and Clerk.
// Everything here answers "what may this authenticated user do?".
//
// A feature module normally needs only three things from this package:
//   1. `requirePermission` (handed to it by the composition root)
//   2. `ResourceRef` — the shape it returns so the policy check can run
//   3. `buildScopeFilter` / `scopeWhere` — for list endpoints
// ============================================================================

// Module factory
export { createAuthzModule } from './module';
export type { AuthzModule, AuthzModuleDeps, AuthzRouters } from './module';

// Constants
export {
    AUTHZ_CACHE,
    AUTHZ_ERROR_CODES,
    AUTHZ_EVENTS,
    AUTHZ_MODULE,
    CLIENT_SURFACE_HEADER,
    ORGANIZATION_HEADER,
} from './constants/authz.constant';
export type { AuthzEventName } from './constants/authz.constant';

// Domain enums
export {
    PERMISSION_SCOPE_RANK,
    PermissionScope,
    isPermissionScope,
    widestScope,
} from './domain/enums/permission-scope.enum';
export { RoleKind, isRoleKind } from './domain/enums/role-kind.enum';
export { AuditActorType, AuditResult } from './domain/enums/audit.enum';

// Permission naming convention
export {
    formatCapabilityKey,
    formatPermissionKey,
    parsePermissionKey,
    tryParsePermissionKey,
} from './domain/permission-key';
export type { PermissionParts } from './domain/permission-key';

// Catalogs (resources, actions, permissions, roles)
export {
    ACTIONS,
    READ_ONLY_ACTIONS,
    RESOURCES,
    isKnownAction,
    isKnownResource,
} from './domain/catalog/resources';
export type { ActionName, ResourceName } from './domain/catalog/resources';
export {
    ALL_PERMISSION_KEYS,
    PERMISSION_BY_KEY,
    PERMISSION_CATALOG,
    SENSITIVE_PERMISSION_KEYS,
} from './domain/catalog/permission-catalog';
export type { PermissionDefinition } from './domain/catalog/permission-catalog';
export {
    ALL_PLATFORM_PERMISSIONS,
    DEFAULT_PLATFORM_ROLE,
    ROLE_BY_KEY,
    ROLE_CATALOG,
    ROLE_KEYS,
    permissionsForRole,
} from './domain/catalog/role-catalog';
export type { RoleDefinition, RoleKey } from './domain/catalog/role-catalog';
export {
    assertCatalogIsSound,
    findCatalogViolations,
} from './domain/catalog/catalog-validation';

// Decision core (pure functions — useful in tests and in services)
export {
    applicableGrants,
    grantAllowsResource,
    grantKeys,
    hasPermission,
    isResourceAllowed,
    requiresStepUp,
    resolveScope,
} from './domain/policy/scope-policy';
export { buildScopeFilter, scopeWhere } from './domain/policy/scope-filter';
export type { ScopeFieldMap, ScopeFilter } from './domain/policy/scope-filter';

// Ports and contracts
export type {
    AuthzPrincipal,
    OrganizationSummary,
    PermissionGrant,
    PermissionRequest,
    ResourceRef,
} from './domain/interfaces/principal.interface';
export type {
    DirectoryUser,
    IUserDirectory,
} from './domain/interfaces/user-directory.interface';

// Services
export type {
    AuthorizationService,
    PermissionManifest,
    PrincipalOptions,
} from './service/authorization.service';
export type { AuditService } from './service/audit.service';
export type { OrganizationService } from './service/organization.service';
export type {
    AssignRoleInput,
    RequestContext,
    RevokeRoleInput,
    RoleAssignmentService,
} from './service/role-assignment.service';

// Middleware
export {
    ensureAuthzContext,
    resolveOrganizationContext,
    withSurface,
} from './middleware/authz-context.middleware';
export { assertStepUpSatisfied, requireStepUp } from './middleware/step-up.middleware';
export type {
    RequirePermission,
    RequirePermissionOptions,
} from './middleware/require-permission.middleware';

// Seeding (used by scripts/seed-authz.ts and by the operations runbook)
export { seedAuthorization } from './seed/seed-authorization';
export type { SeedReport } from './seed/seed-authorization';

// Express type augmentation for req.authz
export type { AuthzContext } from './types/authz.types';
import './types/authz.types';
