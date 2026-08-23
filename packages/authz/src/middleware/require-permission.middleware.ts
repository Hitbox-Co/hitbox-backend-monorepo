import type { Logger } from 'pino';
import type { Request, RequestHandler } from 'express';
import { AppError } from '@hitbox/shared';
import { AUTHZ_ERROR_CODES } from '../constants/authz.constant';
import { AuditActorType, AuditResult } from '../domain/enums/audit.enum';
import type { ActionName, ResourceName } from '../domain/catalog/resources';
import { formatCapabilityKey } from '../domain/permission-key';
import type { ResourceRef } from '../domain/interfaces/principal.interface';
import type { AuthorizationService } from '../service/authorization.service';
import type { AuditService } from '../service/audit.service';
import { ensureAuthzContext } from './authz-context.middleware';
import { assertStepUpSatisfied } from './step-up.middleware';

export interface RequirePermissionDeps {
    authorization: AuthorizationService;
    audit: AuditService;
    logger: Logger;
    /** Max age (minutes) of factor verification accepted for sensitive calls. */
    stepUpMaxAgeMinutes: number;
}

export interface RequirePermissionOptions {
    /**
     * Loads the row being acted on, so the POLICY half of the decision can run
     * inside the middleware. Return null when the row does not exist — the
     * middleware turns that into a 404 without leaking whether the caller would
     * have been allowed.
     *
     * Omit this for collection endpoints (`GET /products`) and instead filter
     * the query by scope; see `scopeFilterFor` in the docs.
     */
    resource?: (req: Request) => Promise<ResourceRef | null> | ResourceRef | null;
    /** Reject the request when no tenant context could be resolved. */
    requireOrganization?: boolean;
    /** Write an audit row even when the call is allowed. Sensitive
     *  capabilities are audited regardless of this flag. */
    audit?: boolean;
    /** Escape hatch: skip the automatic step-up gate. Requires a reason so it
     *  shows up in review. */
    skipStepUp?: string;
}

function requestContext(req: Request) {
    return {
        surface: req.authz?.surface ?? null,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
        requestId: req.header('x-request-id') ?? null,
    };
}

/**
 * THE ROUTE GUARD. One line per endpoint, and it is the only thing a feature
 * module needs to know about authorization:
 *
 *   router.post('/products',
 *       requireAuth,
 *       requirePermission('product', 'create'),
 *       controller.create);
 *
 *   router.patch('/products/:id',
 *       requireAuth,
 *       requirePermission('product', 'update', {
 *           resource: (req) => products.refFor(req.params.id),
 *       }),
 *       controller.update);
 *
 * What it does, in order:
 *   1. loads the principal (cached) and resolves the tenant context
 *   2. PERMISSION CHECK — capability held in this context? else 403
 *   3. step-up gate for capabilities the catalog marks sensitive
 *   4. POLICY CHECK — if `resource` is given, load the row and check
 *      ownership/tenancy; 404 when the row is missing, 403 when it is not theirs
 *   5. audits denials always, and successes for sensitive capabilities
 *
 * Default deny: any unexpected state (no auth, unknown capability, thrown
 * loader) results in a rejection, never a pass-through.
 */
export function createRequirePermission(deps: RequirePermissionDeps) {
    return function requirePermission(
        resource: ResourceName,
        action: ActionName,
        options: RequirePermissionOptions = {},
    ): RequestHandler {
        const capability = formatCapabilityKey(resource, action);

        return async (req, _res, next) => {
            try {
                const context = await ensureAuthzContext(req, deps);
                const { principal, organizationId } = context;
                const request = { resource, action, organizationId };

                if (options.requireOrganization && organizationId === null) {
                    throw AppError.badRequest(
                        'This endpoint requires an organization context — send the X-Organization-Id header',
                        AUTHZ_ERROR_CODES.ORGANIZATION_REQUIRED,
                    );
                }

                // ---------------------------------------- 1. permission check
                if (!deps.authorization.hasPermission(principal, request)) {
                    deps.audit.emitDenial({
                        actorUserId: principal.userId,
                        action: capability,
                        resource,
                        organizationId,
                        reason: 'capability not granted',
                        ...requestContext(req),
                    });
                    throw AppError.forbidden(
                        `Missing permission ${capability}`,
                        AUTHZ_ERROR_CODES.PERMISSION_DENIED,
                    );
                }

                // ------------------------------------------- 2. step-up gate
                const sensitive = deps.authorization.requiresStepUp(principal, request);
                if (sensitive && !options.skipStepUp) {
                    try {
                        assertStepUpSatisfied(req, deps.stepUpMaxAgeMinutes);
                    } catch (error) {
                        deps.audit.emitDenial({
                            actorUserId: principal.userId,
                            action: capability,
                            resource,
                            organizationId,
                            reason: 'step-up verification required',
                            ...requestContext(req),
                        });
                        throw error;
                    }
                }

                // ------------------------------------------ 3. policy check
                if (options.resource) {
                    const ref = await options.resource(req);

                    if (ref === null) {
                        throw AppError.notFound(`${resource} not found`);
                    }

                    if (!deps.authorization.canAccessResource(principal, request, ref)) {
                        deps.audit.emitDenial({
                            actorUserId: principal.userId,
                            action: capability,
                            resource,
                            organizationId,
                            reason: 'resource policy denied',
                            ...requestContext(req),
                        });
                        throw AppError.forbidden(
                            `Not permitted on this ${resource}`,
                            AUTHZ_ERROR_CODES.RESOURCE_FORBIDDEN,
                        );
                    }
                }

                // ------------------------------------------------- 4. audit
                if (sensitive || options.audit) {
                    deps.audit.emit({
                        actorUserId: principal.userId,
                        actorType: AuditActorType.USER,
                        action: capability,
                        resource,
                        organizationId,
                        result: AuditResult.SUCCESS,
                        ...requestContext(req),
                        metadata: {
                            grants: deps.authorization.grantKeysFor(principal, request),
                        },
                    });
                }

                next();
            } catch (error) {
                next(error);
            }
        };
    };
}

export type RequirePermission = ReturnType<typeof createRequirePermission>;
