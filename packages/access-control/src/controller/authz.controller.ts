import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    assignRoleSchema,
    createRoleSchema,
    listPermissionsQuerySchema,
    listRolesQuerySchema,
    revokeRoleQuerySchema,
    updateRoleSchema,
} from '../dto/access-control.dto';
import type { PermissionGuard } from '../middleware/require-permission.middleware';
import type { PermissionService } from '../service/permission.service';
import type { RoleAssignmentService } from '../service/role-assignment.service';
import type { RoleService } from '../service/role.service';

/**
 * HTTP glue for authorization administration. Note there is exactly ONE set
 * of these endpoints — generic role/permission/assignment management, not a
 * screen or route per role (§11).
 */
export class AuthzController {
    constructor(
        private readonly roles: RoleService,
        private readonly permissions: PermissionService,
        private readonly assignments: RoleAssignmentService,
        private readonly guard: PermissionGuard,
    ) { }

    // ── Permission catalog ──────────────────────────────────────────────────

    /** GET /admin/authz/permissions */
    listPermissions: RequestHandler = asyncHandler(async (req, res) => {
        const query = listPermissionsQuerySchema.parse(req.query);
        res.json({ data: this.permissions.list(query), meta: { shape: query.shape } });
    });

    // ── Roles ───────────────────────────────────────────────────────────────

    /** GET /admin/authz/roles */
    listRoles: RequestHandler = asyncHandler(async (req, res) => {
        const query = listRolesQuerySchema.parse(req.query);
        res.json({ data: await this.roles.list(query) });
    });

    /** GET /admin/authz/roles/:roleId */
    getRole: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.roles.getById(req.params.roleId as string) });
    });

    /** POST /admin/authz/roles */
    createRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createRoleSchema.parse(req.body);
        res.status(201).json({ data: await this.roles.create(dto) });
    });

    /** PATCH /admin/authz/roles/:roleId */
    updateRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateRoleSchema.parse(req.body);
        res.json({ data: await this.roles.update(req.params.roleId as string, dto) });
    });

    /** DELETE /admin/authz/roles/:roleId */
    deleteRole: RequestHandler = asyncHandler(async (req, res) => {
        await this.roles.delete(req.params.roleId as string);
        res.status(204).send();
    });

    // ── User role assignments ───────────────────────────────────────────────

    /** GET /admin/authz/users/:userId/roles */
    listUserRoles: RequestHandler = asyncHandler(async (req, res) => {
        const includeRevoked = req.query.includeRevoked === 'true';
        res.json({
            data: await this.assignments.listForUser(req.params.userId as string, includeRevoked),
        });
    });

    /** POST /admin/authz/users/:userId/roles */
    assignRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignRoleSchema.parse(req.body);
        res.status(201).json({
            data: await this.assignments.assign({
                userId: req.params.userId as string,
                dto,
                grantedById: this.guard.principalId(req),
            }),
        });
    });

    /** DELETE /admin/authz/users/:userId/roles/:roleId */
    revokeRole: RequestHandler = asyncHandler(async (req, res) => {
        const query = revokeRoleQuerySchema.parse(req.query);
        await this.assignments.revoke({
            userId: req.params.userId as string,
            roleId: req.params.roleId as string,
            organizationId: query.organizationId,
            revokedById: this.guard.principalId(req),
        });
        res.status(204).send();
    });

    // ── Self ────────────────────────────────────────────────────────────────

    /**
     * GET /authz/me — the caller's own effective permissions and roles.
     * Every authenticated user may read this; it is their own grants, and a
     * client needs it to decide what to render.
     */
    me: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.guard.describePrincipal(req) });
    });
}
