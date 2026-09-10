import type { Request, RequestHandler } from 'express';
import { AppError } from '@hitbox/shared';
import { ACCESS_CONTROL_ERROR_CODES } from '../constants/access-control.constant';
import { parseCapability } from '../domain/permission-key';
import type { AccessContext, AccessGrantDetail } from '../engine/authorization-engine';
import { decide, effectivePermissionKeys } from '../engine/authorization-engine';
import type {
    IPrincipalGrantsLookup,
    Principal,
} from '../domain/interfaces/principal-grants.interface';

/**
 * Resolves the target record's organization / owner from the request, so an
 * ORG- or OWN-scoped grant can be checked against it.
 *
 * Return `undefined` for a field the route cannot know yet. Routes that
 * operate on a single record usually load it in the service and re-check
 * there with `authorize()`; the middleware handles the cheap cases (body /
 * params / query carry the org id).
 */
export type AccessContextResolver = (
    req: Request,
) => AccessContext | Promise<AccessContext>;

export interface RequirePermissionOptions {
    /** How to find the target record's org/owner. Omit for unscoped routes. */
    context?: AccessContextResolver;
}

/** Attached to `req.authz` once a permission check has passed. */
export interface AuthzContext extends AccessGrantDetail {
    userId: string;
    /** The capability that was checked, e.g. "order:refund". */
    capability: string;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            authz?: AuthzContext;
        }
    }
}

/**
 * Reads the authenticated user's local account id off the request, or returns
 * undefined when the request is unauthenticated.
 *
 * Injected rather than imported so this module knows nothing about the
 * authentication mechanism — no Clerk, no `req.auth`, no dependency on
 * @hitbox/auth. Bootstrap supplies the adapter (`req => req.auth?.accountId`),
 * and swapping the identity provider never touches authorization.
 */
export type PrincipalIdResolver = (req: Request) => string | undefined;

export interface PermissionGuardDeps {
    grants: IPrincipalGrantsLookup;
    resolvePrincipalId: PrincipalIdResolver;
}

/**
 * Builds the `requirePermission` guard.
 *
 * Mount it AFTER `requireAuth` — it reads `req.auth.accountId` and refuses
 * to guess an identity. Usage in a business module's router:
 *
 *     router.post('/:id/refund',
 *         requireAuth,
 *         requirePermission('order:refund'),
 *         controller.refund);
 *
 * Note what is absent: the route names a capability, never a role. Any role
 * holding `order:refund` at a scope that reaches the record passes, which is
 * what keeps APIs resource-shaped instead of role-shaped (§2).
 */
export function createRequirePermission(deps: PermissionGuardDeps) {
    /**
     * The caller's account id, or a 401. Guarantees authorization never runs
     * on an anonymous request — a missing principal is a wiring bug (the
     * route was mounted without requireAuth), not a silent deny.
     */
    function principalId(req: Request): string {
        const userId = deps.resolvePrincipalId(req);
        if (!userId) {
            throw AppError.unauthorized(
                'Authentication required before authorization',
                ACCESS_CONTROL_ERROR_CODES.NO_PRINCIPAL,
            );
        }
        return userId;
    }

    /** Loads and memoises the principal for the lifetime of one request. */
    async function loadPrincipal(req: Request): Promise<Principal> {
        const userId = principalId(req);
        const cached = principalCache.get(req);
        if (cached) return cached;

        const principal: Principal = {
            userId,
            grants: await deps.grants.findGrantsByUserId(userId),
        };
        principalCache.set(req, principal);
        return principal;
    }

    /**
     * Per-request memo. A WeakMap keyed on the request object means entries
     * vanish with the request and nothing leaks between them — safer than
     * stashing state on `req` where a later handler could overwrite it.
     */
    const principalCache = new WeakMap<Request, Principal>();

    function requirePermission(
        capability: string,
        options: RequirePermissionOptions = {},
    ): RequestHandler {
        // Parsed once at router-build time: a typo in a guard crashes at boot
        // rather than silently denying every request forever.
        const parsed = parseCapability(capability);
        if (!parsed) {
            throw new Error(
                `requirePermission("${capability}") is not a valid capability. ` +
                `Expected "resource:action" using the ResourceType / PermissionAction enums.`,
            );
        }

        return async (req, _res, next) => {
            try {
                const principal = await loadPrincipal(req);
                const context = options.context ? await options.context(req) : {};
                const decision = decide(principal, { ...parsed, context });

                if (!decision.allowed) {
                    throw AppError.forbidden(
                        'You do not have permission to perform this action',
                        ACCESS_CONTROL_ERROR_CODES.FORBIDDEN,
                    );
                }

                const { allowed: _allowed, reason: _reason, ...detail } = decision;
                req.authz = { userId: principal.userId, capability, ...detail };
                next();
            } catch (error) {
                next(error);
            }
        };
    }

    /**
     * Same decision, callable from a service once the record is loaded and
     * its real organizationId / ownerId are known. Use this for the
     * "check-after-load" half of a scoped update — the middleware guards the
     * route, this guards the row.
     */
    async function authorize(
        req: Request,
        capability: string,
        context: AccessContext,
    ): Promise<AuthzContext> {
        const parsed = parseCapability(capability);
        if (!parsed) {
            throw new Error(`authorize("${capability}") is not a valid capability.`);
        }
        const principal = await loadPrincipal(req);
        const decision = decide(principal, { ...parsed, context });
        if (!decision.allowed) {
            throw AppError.forbidden(
                'You do not have permission to perform this action',
                ACCESS_CONTROL_ERROR_CODES.FORBIDDEN,
            );
        }
        const { allowed: _allowed, reason: _reason, ...detail } = decision;
        return { userId: principal.userId, capability, ...detail };
    }

    /** Backs GET /authz/me. */
    async function describePrincipal(req: Request): Promise<{
        userId: string;
        permissions: string[];
        roles: { roleId: string; roleName: string; organizationId: string | null }[];
    }> {
        const principal = await loadPrincipal(req);
        const roles = new Map<string, { roleId: string; roleName: string; organizationId: string | null }>();
        for (const grant of principal.grants) {
            const key = `${grant.roleId}:${grant.assignmentScopeId ?? ''}`;
            if (!roles.has(key)) {
                roles.set(key, {
                    roleId: grant.roleId,
                    roleName: grant.roleName,
                    organizationId: grant.assignmentScopeId,
                });
            }
        }
        return {
            userId: principal.userId,
            permissions: effectivePermissionKeys(principal),
            roles: [...roles.values()],
        };
    }

    return { requirePermission, authorize, describePrincipal, principalId };
}

export type PermissionGuard = ReturnType<typeof createRequirePermission>;
