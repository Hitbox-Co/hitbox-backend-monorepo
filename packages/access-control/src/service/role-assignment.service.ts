import { RoleScopeType } from '@hitbox/database';
import type { AuthorizationDomain } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    ACCESS_CONTROL_ERROR_CODES,
    ACCESS_CONTROL_EVENTS,
} from '../constants/access-control.constant';
import type { AssignRoleDto } from '../dto/access-control.dto';
import type { RoleRepository } from '../repository/role.repository';
import type {
    AssignmentWithRole,
    RoleAssignmentRepository,
} from '../repository/role-assignment.repository';

export interface AssignmentResponse {
    id: string;
    userId: string;
    roleId: string;
    roleName: string;
    roleDisplayName: string;
    domain: AuthorizationDomain;
    scopeType: RoleScopeType;
    organizationId: string | null;
    grantedById: string;
    grantedAt: Date;
    revokedAt: Date | null;
}

export interface RoleAssignmentServiceDeps {
    assignments: RoleAssignmentRepository;
    roles: RoleRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/**
 * Grants and revokes roles. A user may hold any number of assignments (§8) —
 * ARTIST plus BRAND_EMPLOYEE at brand A plus HITBOX_FULL_STACK_ENGINEER is a
 * normal state, and their effective permissions are the union. Nothing here
 * merges roles or creates combined ones.
 */
export class RoleAssignmentService {
    constructor(private readonly deps: RoleAssignmentServiceDeps) { }

    async listForUser(userId: string, includeRevoked = false): Promise<AssignmentResponse[]> {
        const rows = await this.deps.assignments.findByUserId(userId, includeRevoked);
        return rows.map(toResponse);
    }

    async assign(input: {
        userId: string;
        dto: AssignRoleDto;
        /** The administrator performing the grant, from req.auth. */
        grantedById: string;
    }): Promise<AssignmentResponse> {
        const role = await this.deps.roles.findById(input.dto.roleId);
        if (!role) {
            throw AppError.notFound('Role not found', ACCESS_CONTROL_ERROR_CODES.ROLE_NOT_FOUND);
        }
        if (!role.isActive) {
            throw AppError.badRequest(
                `${role.name} is deactivated and cannot be assigned`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_NOT_FOUND,
            );
        }

        // Fall back to the role's natural scope so a caller does not have to
        // know that BRAND_ADMIN is org-scoped and HITBOX_SUPPORT is not.
        const scopeType = input.dto.scopeType ?? defaultScopeFor(role.entityGroup);
        const scopeId = scopeType === RoleScopeType.ORGANIZATION ? (input.dto.organizationId ?? null) : null;

        if (scopeType === RoleScopeType.ORGANIZATION && !scopeId) {
            throw AppError.badRequest(
                `${role.name} is organization-scoped; an organizationId is required`,
                ACCESS_CONTROL_ERROR_CODES.MISSING_ORG_SCOPE,
            );
        }

        const existing = await this.deps.assignments.findLive({
            userId: input.userId,
            roleId: role.id,
            scopeType,
            scopeId,
        });
        if (existing) {
            throw AppError.conflict(
                `User already holds ${role.name} at this scope`,
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS,
                { assignmentId: existing.id },
            );
        }

        const assignment = await this.deps.assignments.create({
            userId: input.userId,
            roleId: role.id,
            scopeType,
            scopeId,
            grantedById: input.grantedById,
        });

        this.deps.logger.info(
            {
                assignmentId: assignment.id,
                userId: input.userId,
                role: role.name,
                domain: role.domain,
                scopeType,
                organizationId: scopeId,
                grantedById: input.grantedById,
            },
            'role assigned',
        );
        await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_ASSIGNED, {
            assignmentId: assignment.id,
            userId: input.userId,
            roleId: role.id,
            roleName: role.name,
            domain: role.domain,
            scopeType,
            organizationId: scopeId,
            grantedById: input.grantedById,
        });
        return toResponse(assignment);
    }

    /**
     * Revokes by (user, role, optional organization) rather than assignment
     * id, so the admin panel can revoke straight from the role list.
     */
    async revoke(input: {
        userId: string;
        roleId: string;
        organizationId?: string | undefined;
        revokedById: string;
    }): Promise<AssignmentResponse> {
        const live = await this.deps.assignments.findByUserId(input.userId);
        const match = live.find(
            (row) =>
                row.roleId === input.roleId &&
                (input.organizationId === undefined ||
                    row.scopeId === input.organizationId),
        );
        if (!match) {
            throw AppError.notFound(
                'No active assignment of that role for this user',
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_NOT_FOUND,
            );
        }

        const revoked = await this.deps.assignments.revoke(match.id);
        this.deps.logger.info(
            {
                assignmentId: match.id,
                userId: input.userId,
                role: match.role.name,
                revokedById: input.revokedById,
            },
            'role revoked',
        );
        await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_REVOKED, {
            assignmentId: match.id,
            userId: input.userId,
            roleId: match.roleId,
            roleName: match.role.name,
            revokedById: input.revokedById,
        });
        return toResponse(revoked);
    }
}

/** A role's natural assignment breadth, from its persona family. */
function defaultScopeFor(entityGroup: string): RoleScopeType {
    switch (entityGroup) {
        case 'brand_artist':
            return RoleScopeType.ORGANIZATION;
        case 'end_user':
            return RoleScopeType.OWN;
        default:
            return RoleScopeType.GLOBAL;
    }
}

function toResponse(assignment: AssignmentWithRole): AssignmentResponse {
    return {
        id: assignment.id,
        userId: assignment.userId,
        roleId: assignment.roleId,
        roleName: assignment.role.name,
        roleDisplayName: assignment.role.displayName,
        domain: assignment.role.domain,
        scopeType: assignment.scopeType,
        organizationId: assignment.scopeId,
        grantedById: assignment.grantedById,
        grantedAt: assignment.grantedAt,
        revokedAt: assignment.revokedAt,
    };
}
