import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, RoleScopeType } from '@hitbox/database';
import type {
    IPrincipalGrantsLookup,
    PrincipalGrant,
} from '../domain/interfaces/principal-grants.interface';

const assignmentInclude = {
    role: true,
} satisfies Prisma.RoleAssignmentInclude;

export type AssignmentWithRole = Prisma.RoleAssignmentGetPayload<{
    include: typeof assignmentInclude;
}>;

/**
 * Owns `role_assignments` and implements the grants lookup the engine reads
 * through. This is the only place that flattens
 * RoleAssignment → Role → RolePermission → Permission into grants.
 */
export class RoleAssignmentRepository implements IPrincipalGrantsLookup {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Effective grants for a user: the union across every live assignment.
     *
     * Filters that matter for security:
     *   • `revokedAt: null`   — revoked assignments confer nothing.
     *   • `role.isActive`     — deactivating a role kills it everywhere at once.
     *   • `permission.isActive` — retired catalog entries stop granting.
     */
    async findGrantsByUserId(userId: string): Promise<PrincipalGrant[]> {
        const assignments = await this.prisma.roleAssignment.findMany({
            where: { userId, revokedAt: null, role: { isActive: true } },
            include: {
                role: {
                    include: {
                        rolePermissions: {
                            where: { permission: { isActive: true } },
                            include: { permission: true },
                        },
                    },
                },
            },
        });

        const grants: PrincipalGrant[] = [];
        for (const assignment of assignments) {
            for (const rolePermission of assignment.role.rolePermissions) {
                const { permission } = rolePermission;
                grants.push({
                    resource: permission.resource,
                    action: permission.action,
                    scope: permission.scope,
                    domain: permission.domain,
                    roleId: assignment.role.id,
                    roleName: assignment.role.name,
                    roleDomain: assignment.role.domain,
                    assignmentScopeType: assignment.scopeType,
                    assignmentScopeId: assignment.scopeId,
                    fieldAllowlist: rolePermission.fieldAllowlist,
                });
            }
        }
        return grants;
    }

    findByUserId(userId: string, includeRevoked = false): Promise<AssignmentWithRole[]> {
        return this.prisma.roleAssignment.findMany({
            where: { userId, ...(includeRevoked ? {} : { revokedAt: null }) },
            include: assignmentInclude,
            orderBy: { grantedAt: 'desc' },
        });
    }

    findById(id: string): Promise<AssignmentWithRole | null> {
        return this.prisma.roleAssignment.findUnique({
            where: { id },
            include: assignmentInclude,
        });
    }

    findLive(input: {
        userId: string;
        roleId: string;
        scopeType: RoleScopeType;
        scopeId: string | null;
    }): Promise<AssignmentWithRole | null> {
        return this.prisma.roleAssignment.findFirst({
            where: { ...input, revokedAt: null },
            include: assignmentInclude,
        });
    }

    async create(input: {
        userId: string;
        roleId: string;
        scopeType: RoleScopeType;
        scopeId: string | null;
        grantedById: string;
    }): Promise<AssignmentWithRole> {
        const id = randomUUID();
        await this.prisma.roleAssignment.create({
            data: { id, ...input, grantedAt: new Date() },
        });
        return (await this.findById(id))!;
    }

    /**
     * Soft revoke. The row stays so the audit trail can answer "who held what
     * in March" — a hard delete would erase exactly the evidence a review
     * needs.
     */
    async revoke(id: string): Promise<AssignmentWithRole> {
        await this.prisma.roleAssignment.update({
            where: { id },
            data: { revokedAt: new Date() },
        });
        return (await this.findById(id))!;
    }
}
