import type { Logger } from 'pino';
import type { Request, RequestHandler } from 'express';
import { AppError } from '@hitbox/shared';
import {
    AUTHZ_ERROR_CODES,
    CLIENT_SURFACE_HEADER,
    ORGANIZATION_HEADER,
} from '../constants/authz.constant';
import { RESOURCES, ACTIONS } from '../domain/catalog/resources';
import { PermissionScope } from '../domain/enums/permission-scope.enum';
import { applicableGrants } from '../domain/policy/scope-policy';
import type { AuthorizationService } from '../service/authorization.service';
import type { AuthzContext } from '../types/authz.types';

export interface AuthzContextDeps {
    authorization: AuthorizationService;
    logger: Logger;
}

/**
 * Reads the requested tenant from (in order): the URL param, the explicit
 * header, then the query string. Params win because a route like
 * `/organizations/:organizationId/products` states the tenant unambiguously.
 */
function requestedOrganizationId(req: Request): string | null {
    const fromParams = req.params?.organizationId;
    if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams;

    const fromHeader = req.header(ORGANIZATION_HEADER);
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;

    const fromQuery = req.query?.organizationId;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

    return null;
}

/**
 * ORGANIZATION CONTEXT RESOLUTION — one definition, used by every route, so no
 * endpoint can accidentally invent its own notion of "which tenant is this".
 *
 *  - explicit tenant + active membership     -> that tenant
 *  - explicit tenant, no membership, but the
 *    caller holds `organization:read:any`    -> that tenant (platform operator
 *                                               inspecting a tenant; they gain
 *                                               nothing from the context beyond
 *                                               the `any` grants they already
 *                                               hold, because org-tagged grants
 *                                               are only ever their own)
 *  - explicit tenant, otherwise              -> 403
 *  - no explicit tenant, exactly one
 *    membership                              -> that tenant (convenience)
 *  - no explicit tenant, several memberships -> null; the client must choose,
 *                                               so we never guess which tenant
 *                                               a write lands in
 */
export function resolveOrganizationContext(
    principal: Parameters<AuthorizationService['describe']>[0],
    req: Request,
): string | null {
    const requested = requestedOrganizationId(req);

    if (requested !== null) {
        const isMember = principal.organizations.some(
            (organization) => organization.id === requested,
        );
        if (isMember) return requested;

        const isPlatformOperator = applicableGrants(principal, {
            resource: RESOURCES.ORGANIZATION,
            action: ACTIONS.READ,
            organizationId: null,
        }).some((grant) => grant.scope === PermissionScope.ANY);

        if (isPlatformOperator) return requested;

        // Same response whether the tenant is missing or simply not theirs —
        // do not leak which organizations exist.
        throw AppError.forbidden(
            'You are not a member of this organization',
            AUTHZ_ERROR_CODES.ORGANIZATION_FORBIDDEN,
        );
    }

    if (principal.organizations.length === 1) {
        return principal.organizations[0]?.id ?? null;
    }
    return null;
}

/**
 * Loads the authorization snapshot for the authenticated user and attaches
 * `req.authz`. Idempotent, so `requirePermission` can call it lazily and a
 * route never has to remember to mount it first.
 */
export async function ensureAuthzContext(
    req: Request,
    deps: AuthzContextDeps,
): Promise<AuthzContext> {
    if (req.authz) return req.authz;

    const auth = req.auth;
    if (!auth) {
        // A programming error, not a client error: requirePermission was mounted
        // on a route without requireAuth in front of it. Fail loudly.
        deps.logger.error(
            { path: req.originalUrl },
            'authorization middleware ran without an authenticated principal — is requireAuth mounted?',
        );
        throw AppError.unauthorized(
            'Authentication required',
            AUTHZ_ERROR_CODES.MISSING_AUTH_CONTEXT,
        );
    }

    const principal = await deps.authorization.getPrincipal(auth.accountId);

    const context: AuthzContext = {
        principal,
        identity: { accountId: auth.accountId, clerkUserId: auth.clerkUserId },
        organizationId: resolveOrganizationContext(principal, req),
        // withSurface() stamps the header from the router tree, so this is the
        // surface the request actually arrived on, not a client-supplied value.
        surface: req.header(CLIENT_SURFACE_HEADER) ?? null,
    };
    req.authz = context;
    return context;
}

/**
 * Explicit version of the above, for routes that want the principal available
 * without demanding a specific permission (e.g. `GET /authz/me`).
 */
export function createWithAuthz(deps: AuthzContextDeps): RequestHandler {
    return async (req, _res, next) => {
        try {
            await ensureAuthzContext(req, deps);
            next();
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Tags the request with the API surface it arrived on. Mounted once per surface
 * router in the backend composition root, so audit rows can distinguish an
 * action taken from admin.hitbox.com from the same action taken in the mobile
 * app.
 */
export function withSurface(surface: string): RequestHandler {
    return (req, _res, next) => {
        // Overwrite rather than trust the client: the surface is decided by
        // which router tree the request landed in, never by a header the caller
        // controls. ensureAuthzContext reads it back out of req.headers.
        req.headers[CLIENT_SURFACE_HEADER] = surface;
        if (req.authz) req.authz.surface = surface;
        next();
    };
}
