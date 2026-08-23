import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { AUTHZ_ERROR_CODES } from '../constants/authz.constant';
import { RoleKind } from '../domain/enums/role-kind.enum';
import { PermissionScope } from '../domain/enums/permission-scope.enum';
import { ACTIONS, RESOURCES } from '../domain/catalog/resources';
import { PERMISSION_CATALOG } from '../domain/catalog/permission-catalog';
import { formatPermissionKey } from '../domain/permission-key';
import type { AuthzContext } from '../types/authz.types';
import {
    assignRoleSchema,
    auditQuerySchema,
    listRolesQuerySchema,
    revokeRoleSchema,
} from '../dto/authz.dto';
import type { AuthorizationService } from '../service/authorization.service';
import type { AuditService } from '../service/audit.service';
import type { RoleAssignmentService } from '../service/role-assignment.service';
import type { AuthzRepository } from '../repository/authz.repository';

/** Every route here runs behind requireAuth + requirePermission, so the
 *  context is guaranteed present by the time a handler runs. */
function contextOf(req: Request): AuthzContext {
    const context = req.authz;
    if (!context) {
        throw AppError.unauthorized(
            'Authentication required',
            AUTHZ_ERROR_CODES.MISSING_AUTH_CONTEXT,
        );
    }
    return context;
}

function requestContext(req: Request) {
    return {
        surface: req.authz?.surface ?? null,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
        requestId: req.header('x-request-id') ?? null,
    };
}

export class AuthzController {
    constructor(
        private readonly authorization: AuthorizationService,
        private readonly roles: RoleAssignmentService,
        private readonly audit: AuditService,
        private readonly repository: AuthzRepository,
    ) { }

    /**
     * GET /authz/me — the permission manifest every frontend bootstraps with.
     *
     * This is the ONLY thing a client needs to render navigation, menus and
     * buttons correctly. It is explicitly a UX aid: the backend re-derives and
     * re-checks permissions on every single call, so a tampered response buys
     * the caller nothing but a misleading UI.
     */
    me: RequestHandler = asyncHandler(async (req, res) => {
        const { principal, organizationId } = contextOf(req);
        res.json({
            data: {
                ...this.authorization.describe(principal),
                activeOrganizationId: organizationId,
            },
        });
    });

    /** GET /authz/roles — role definitions and the permissions they carry. */
    listRoles: RequestHandler = asyncHandler(async (req, res) => {
        const query = listRolesQuerySchema.parse(req.query);
        const roles = await this.repository.listRoles(
            query.kind ? (query.kind as RoleKind) : undefined,
        );

        // An organization administrator has no business enumerating platform
        // roles — that would tell them exactly what to aim for.
        const { principal } = contextOf(req);
        const isPlatformOperator = this.authorization.hasPermissionAtScope(
            principal,
            { resource: RESOURCES.ROLE, action: ACTIONS.READ, organizationId: null },
            PermissionScope.ANY,
        );

        const visible = isPlatformOperator
            ? roles
            : roles.filter((role) => role.kind === RoleKind.ORGANIZATION && !role.isPrivileged);

        res.json({ data: visible });
    });

    /** GET /authz/permissions — the catalog, for admin tooling. */
    listPermissions: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({
            data: PERMISSION_CATALOG.map((permission) => ({
                key: formatPermissionKey(permission),
                resource: permission.resource,
                action: permission.action,
                scope: permission.scope,
                description: permission.description,
                sensitive: permission.sensitive,
            })),
        });
    });

    /** GET /authz/users/:userId/roles */
    listUserRoles: RequestHandler = asyncHandler(async (req, res) => {
        const { organizationId } = contextOf(req);
        const userId = req.params.userId as string;
        // An org administrator only ever sees assignments inside their tenant.
        const assignments = await this.roles.listForUser(
            userId,
            organizationId === null ? undefined : organizationId,
        );
        res.json({ data: assignments });
    });

    /**
     * POST /authz/users/:userId/roles — grant a role.
     *
     * The principal is re-read with `fresh: true`: role management is exactly
     * the operation where a few seconds of cached permissions is not good
     * enough, because the actor's own authority may have just been revoked.
     */
    assignRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignRoleSchema.parse(req.body);
        const { organizationId } = contextOf(req);
        const actor = await this.authorization.getPrincipal(
            (req.auth as NonNullable<typeof req.auth>).accountId,
            { fresh: true },
        );

        const result = await this.roles.assign({
            actor,
            targetUserId: req.params.userId as string,
            roleKey: dto.roleKey,
            organizationId: dto.organizationId ?? organizationId,
            expiresAt: dto.expiresAt ?? null,
            context: requestContext(req),
        });

        res.status(result.created ? 201 : 200).json({
            data: { assigned: true, created: result.created },
        });
    });

    /** DELETE /authz/users/:userId/roles/:roleKey */
    revokeRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = revokeRoleSchema.parse({
            roleKey: req.params.roleKey,
            organizationId: req.body?.organizationId ?? req.query?.organizationId,
        });
        const { organizationId } = contextOf(req);
        const actor = await this.authorization.getPrincipal(
            (req.auth as NonNullable<typeof req.auth>).accountId,
            { fresh: true },
        );

        await this.roles.revoke({
            actor,
            targetUserId: req.params.userId as string,
            roleKey: dto.roleKey,
            organizationId: dto.organizationId ?? organizationId,
            context: requestContext(req),
        });

        res.status(204).send();
    });

    /**
     * GET /authz/audit-logs — an organization administrator is confined to
     * their own tenant's trail; only a platform operator sees everything.
     */
    listAuditLogs: RequestHandler = asyncHandler(async (req, res) => {
        const query = auditQuerySchema.parse(req.query);
        const { principal, organizationId } = contextOf(req);

        // ANY scope means a platform operator; anything narrower is confined.
        const seesEverything = this.authorization.hasPermissionAtScope(
            principal,
            { resource: RESOURCES.AUDIT_LOG, action: ACTIONS.READ, organizationId },
            PermissionScope.ANY,
        );

        const result = await this.audit.list({
            ...query,
            ...(seesEverything ? {} : { organizationId }),
        });

        res.json({ data: result.items, meta: { nextCursor: result.nextCursor } });
    });
}
