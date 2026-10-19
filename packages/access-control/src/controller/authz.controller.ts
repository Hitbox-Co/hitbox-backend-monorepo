import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    assignRoleSchema,
    createRoleSchema,
    listPermissionsQuerySchema,
    listRolesQuerySchema,
    inviteStaffSchema,
    listInvitationsQuerySchema,
    listTeamQuerySchema,
    revokeInvitationSchema,
    revokeRoleQuerySchema,
    updateRoleSchema,
} from '../dto/access-control.dto';
import type { PermissionGuard } from '../middleware/require-permission.middleware';
import type { PermissionService } from '../service/permission.service';
import type { RoleAssignmentService } from '../service/role-assignment.service';
import type { RoleService } from '../service/role.service';
import type { StaffInvitationService } from '../service/staff-invitation.service';

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
        private readonly invitations: StaffInvitationService,
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

    /**
     * GET /admin/authz/team — everyone holding at least one live role.
     *
     * The caller's organization reach is derived from their own grants, never
     * from the request: a globally-scoped administrator sees the whole team,
     * an org-scoped one (Brand Admin) sees only people assigned within their
     * organizations.
     */
    listTeam: RequestHandler = asyncHandler(async (req, res) => {
        const query = listTeamQuerySchema.parse(req.query);
        const principal = await this.guard.describePrincipal(req);
        const global = principal.permissions.includes('employee-role-mgmt:manage:global');
        const organizationIds = global
            ? null
            : [
                ...new Set(
                    principal.roles
                        .map((role) => role.organizationId)
                        .filter((id): id is string => id !== null),
                ),
            ];
        res.json(await this.assignments.listTeam({ query, organizationIds }));
    });

    /** POST /admin/authz/users/:userId/roles */
    assignRole: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignRoleSchema.parse(req.body);
        // The granter's own permissions, for the no-escalation check. Read from
        // their grant, never from the request.
        const principal = await this.guard.describePrincipal(req);
        res.status(201).json({
            data: await this.assignments.assign({
                userId: req.params.userId as string,
                dto,
                grantedById: principal.userId,
                granterPermissions: principal.permissions,
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

    // ── Staff invitations ───────────────────────────────────────────────────

    /**
     * POST /admin/authz/invitations
     *
     * Invite an email address to hold a role. Two outcomes: the role is granted
     * immediately (the address already has an account) or an invitation email
     * goes out and the role is granted when they accept. The response says
     * which, because the dashboard has to tell the operator what happened.
     */
    inviteStaff: RequestHandler = asyncHandler(async (req, res) => {
        const dto = inviteStaffSchema.parse(req.body);
        // The inviter's own permission set — this is what the no-escalation
        // check compares the role against. Read from the grant, never the body.
        const principal = await this.guard.describePrincipal(req);
        const result = await this.invitations.invite({
            dto,
            invitedById: principal.userId,
            inviterPermissions: principal.permissions,
        });
        res.status(201).json({ data: result });
    });

    /** GET /admin/authz/invitations */
    listInvitations: RequestHandler = asyncHandler(async (req, res) => {
        const query = listInvitationsQuerySchema.parse(req.query);
        const principal = await this.guard.describePrincipal(req);
        const global = principal.permissions.includes('employee-role-mgmt:manage:global');
        const organizationIds = global
            ? null
            : [
                ...new Set(
                    principal.roles
                        .map((role) => role.organizationId)
                        .filter((id): id is string => id !== null),
                ),
            ];
        res.json(await this.invitations.list({ query, organizationIds }));
    });

    /** POST /admin/authz/invitations/:invitationId/revoke */
    revokeInvitation: RequestHandler = asyncHandler(async (req, res) => {
        const dto = revokeInvitationSchema.parse(req.body);
        res.json({
            data: await this.invitations.revoke({
                id: req.params.invitationId as string,
                revokedById: this.guard.principalId(req),
                reason: dto.reason,
            }),
        });
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
