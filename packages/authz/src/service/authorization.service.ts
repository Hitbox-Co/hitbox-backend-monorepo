import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import { AUTHZ_ERROR_CODES } from '../constants/authz.constant';
import { PermissionScope, PERMISSION_SCOPE_RANK } from '../domain/enums/permission-scope.enum';
import type {
    AuthzPrincipal,
    PermissionRequest,
    ResourceRef,
} from '../domain/interfaces/principal.interface';
import {
    applicableGrants,
    grantKeys,
    hasPermission,
    isResourceAllowed,
    requiresStepUp,
    resolveScope,
} from '../domain/policy/scope-policy';
import { formatCapabilityKey, formatPermissionKey } from '../domain/permission-key';
import type { PermissionCache } from '../cache/permission-cache';
import type { AuthzRepository } from '../repository/authz.repository';

export interface AuthorizationServiceDeps {
    repository: AuthzRepository;
    cache: PermissionCache;
    logger: Logger;
}

export interface PrincipalOptions {
    /**
     * Skip both cache tiers and read the database. Used for sensitive
     * operations (role management, money movement) where a few seconds of
     * staleness is not acceptable.
     */
    fresh?: boolean;
}

/** The payload frontends consume to drive navigation and control visibility. */
export interface PermissionManifest {
    userId: string;
    platformRoles: string[];
    organizations: { id: string; slug: string; name: string; roles: string[] }[];
    /** Flat `resource:action:scope` list. UX only — never a security boundary. */
    permissions: string[];
    /** Highest scope per `resource:action`, so a client can answer "can I edit
     *  anything, or only my own?" without parsing scopes itself. */
    capabilities: Record<string, string>;
}

/**
 * THE CENTRAL AUTHORIZATION SERVICE — the only component allowed to answer
 * "may this user do that?". Controllers and services ask it; they never inspect
 * roles themselves. That is what keeps `if (role === 'ADMIN')` out of the
 * codebase and makes a permission change a data change.
 *
 * The two halves of a decision stay separate on purpose:
 *   requirePermission()      capability — cheap, runs before any DB read
 *   requireResourceAccess()  policy     — needs the row, runs after loading it
 */
export class AuthorizationService {
    private readonly repository: AuthzRepository;
    private readonly cache: PermissionCache;
    private readonly logger: Logger;

    constructor(deps: AuthorizationServiceDeps) {
        this.repository = deps.repository;
        this.cache = deps.cache;
        this.logger = deps.logger;
    }

    // ------------------------------------------------------------- principal

    /** Cache-through read of a user's effective authorization snapshot. */
    async getPrincipal(userId: string, options: PrincipalOptions = {}): Promise<AuthzPrincipal> {
        if (!options.fresh) {
            const cached = await this.cache.get(userId);
            if (cached) return cached;
        }

        const principal = await this.repository.loadPrincipal(userId);
        await this.cache.set(userId, principal);
        return principal;
    }

    // ------------------------------------------------- 1. permission check

    /** Does any role grant this capability in this tenant context? */
    hasPermission(principal: AuthzPrincipal, request: PermissionRequest): boolean {
        return hasPermission(principal, request);
    }

    /**
     * Explicit-scope variant, for the rare caller that needs to know a
     * capability is held at least as widely as some scope (e.g. "may this user
     * act platform-wide?"). Prefer the resource policy check instead.
     */
    hasPermissionAtScope(
        principal: AuthzPrincipal,
        request: PermissionRequest,
        minimumScope: PermissionScope,
    ): boolean {
        return applicableGrants(principal, request).some(
            (grant) =>
                PERMISSION_SCOPE_RANK[grant.scope] >= PERMISSION_SCOPE_RANK[minimumScope],
        );
    }

    /** Throws 403 when the capability is not held. Default deny. */
    requirePermission(principal: AuthzPrincipal, request: PermissionRequest): void {
        if (this.hasPermission(principal, request)) return;

        this.logger.debug(
            {
                userId: principal.userId,
                capability: formatCapabilityKey(request.resource, request.action),
                organizationId: request.organizationId,
            },
            'permission denied',
        );

        throw AppError.forbidden(
            `Missing permission ${formatCapabilityKey(request.resource, request.action)}`,
            AUTHZ_ERROR_CODES.PERMISSION_DENIED,
        );
    }

    /** The widest scope held, or null. Informational. */
    resolveScope(
        principal: AuthzPrincipal,
        request: PermissionRequest,
    ): PermissionScope | null {
        return resolveScope(principal, request);
    }

    /** True when this capability needs a recently verified session. */
    requiresStepUp(principal: AuthzPrincipal, request: PermissionRequest): boolean {
        return requiresStepUp(principal, request);
    }

    // ---------------------------------------------------- 2. policy check

    /** May they perform this action on THIS row? */
    canAccessResource(
        principal: AuthzPrincipal,
        request: PermissionRequest,
        resource: ResourceRef,
    ): boolean {
        return isResourceAllowed(principal, request, resource);
    }

    /**
     * Throws 403 when the capability is held but not for this row (wrong owner
     * or wrong tenant). Kept distinct from PERMISSION_DENIED so operators can
     * tell "role misconfigured" apart from "tried to reach another tenant".
     */
    requireResourceAccess(
        principal: AuthzPrincipal,
        request: PermissionRequest,
        resource: ResourceRef,
    ): void {
        if (this.canAccessResource(principal, request, resource)) return;

        const scope = this.resolveScope(principal, request);

        this.logger.warn(
            {
                userId: principal.userId,
                capability: formatCapabilityKey(request.resource, request.action),
                heldScope: scope,
                requestOrganizationId: request.organizationId,
                resourceOwnerId: resource.ownerId ?? null,
                resourceOrganizationId: resource.organizationId ?? null,
            },
            'resource policy denied',
        );

        throw AppError.forbidden(
            scope === null
                ? `Missing permission ${formatCapabilityKey(request.resource, request.action)}`
                : `Not permitted on this ${request.resource}`,
            scope === null
                ? AUTHZ_ERROR_CODES.PERMISSION_DENIED
                : AUTHZ_ERROR_CODES.RESOURCE_FORBIDDEN,
        );
    }

    /**
     * Convenience for the common controller shape: check the capability and the
     * row in one call, after the row has been loaded.
     */
    authorize(
        principal: AuthzPrincipal,
        request: PermissionRequest,
        resource: ResourceRef,
    ): void {
        this.requirePermission(principal, request);
        this.requireResourceAccess(principal, request, resource);
    }

    // ------------------------------------------------------------ frontend

    /**
     * What `GET /authz/me` returns. Everything here is for UX (hiding menus and
     * buttons); the backend re-checks every call regardless of what the client
     * believes.
     */
    describe(principal: AuthzPrincipal): PermissionManifest {
        const capabilities: Record<string, string> = {};
        for (const grant of principal.grants) {
            const capability = formatCapabilityKey(grant.resource, grant.action);
            const current = capabilities[capability];
            if (
                current === undefined ||
                PERMISSION_SCOPE_RANK[grant.scope] >
                PERMISSION_SCOPE_RANK[current.toUpperCase() as PermissionScope]
            ) {
                capabilities[capability] = grant.scope.toLowerCase();
            }
        }

        return {
            userId: principal.userId,
            platformRoles: principal.platformRoles,
            organizations: principal.organizations,
            permissions: grantKeys(principal),
            capabilities,
        };
    }

    /** `resource:action:scope` keys, e.g. for embedding in an audit record. */
    grantKeysFor(principal: AuthzPrincipal, request: PermissionRequest): string[] {
        return applicableGrants(principal, request).map(formatPermissionKey);
    }

    // -------------------------------------------------------- invalidation

    /** After a role/membership change for one user. */
    invalidate(userId: string): Promise<void> {
        return this.cache.invalidateUser(userId);
    }

    invalidateMany(userIds: readonly string[]): Promise<void> {
        return this.cache.invalidateUsers(userIds);
    }

    /** After a catalog-level change (role permissions, seeding). */
    invalidateEverything(): Promise<void> {
        return this.cache.invalidateAll();
    }
}
