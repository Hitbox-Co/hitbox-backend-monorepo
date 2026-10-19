import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, RoleScopeType } from '@hitbox/database';
import { HITBOX_ENTITY_GROUP } from '../constants/access-control.constant';
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

/** One person on the Team screen: the user plus their live role assignments. */
export interface TeamMemberRow {
    id: string;
    fullName: string | null;
    handle: string | null;
    email: string;
    avatarUrl: string | null;
    isActive: boolean;
    createdAt: Date;
    roleAssignment_user: {
        id: string;
        scopeType: RoleScopeType;
        scopeId: string | null;
        grantedAt: Date;
        role: {
            id: string;
            name: string;
            displayName: string | null;
            domain: string;
            entityGroup: string;
            isSystem: boolean;
        };
    }[];
}

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

    /**
     * People who hold at least one live role, for the Team screen.
     *
     * Driven from `User` rather than from `RoleAssignment` so one row comes
     * back per person with their roles nested — querying assignments instead
     * would return one row per (person × role) and force the client to
     * regroup, which is exactly the kind of shape that produces a duplicated
     * person in a list.
     *
     * `organizationIds` narrows to assignments scoped to those organizations,
     * so a Brand Admin sees their own people rather than the whole platform.
     * Null means unrestricted.
     */
    async findTeam(input: {
        search?: string | undefined;
        organizationIds: string[] | null;
        /**
         * Restrict to HitBox internal staff — anyone holding a role whose
         * `entityGroup` is `hitbox_seller_org`. This is the Team screen's
         * default: it lists the people who operate the platform, not the
         * thousands of brand users who also carry roles.
         */
        internalOnly: boolean;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: TeamMemberRow[] }> {
        const liveAssignment: Prisma.RoleAssignmentWhereInput = {
            revokedAt: null,
            role: {
                isActive: true,
                ...(input.internalOnly ? { entityGroup: HITBOX_ENTITY_GROUP } : {}),
            },
            ...(input.organizationIds === null
                ? {}
                : { scopeId: { in: input.organizationIds } }),
        };

        const where: Prisma.UserWhereInput = {
            // "Team" means anyone carrying a live role — the admin population
            // is defined by grants, not by a flag on the user row.
            roleAssignment_user: { some: liveAssignment },
            ...(input.search
                ? {
                    OR: [
                        { fullName: { contains: input.search, mode: Prisma.QueryMode.insensitive } },
                        { email: { contains: input.search, mode: Prisma.QueryMode.insensitive } },
                        { handle: { contains: input.search, mode: Prisma.QueryMode.insensitive } },
                    ],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.user.count({ where }),
            this.prisma.user.findMany({
                where,
                select: {
                    id: true,
                    fullName: true,
                    handle: true,
                    email: true,
                    avatarUrl: true,
                    isActive: true,
                    createdAt: true,
                    roleAssignment_user: {
                        where: liveAssignment,
                        select: {
                            id: true,
                            scopeType: true,
                            scopeId: true,
                            grantedAt: true,
                            role: {
                                select: {
                                    id: true, name: true, displayName: true,
                                    domain: true, entityGroup: true, isSystem: true,
                                },
                            },
                        },
                        orderBy: { grantedAt: 'asc' },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip: input.skip,
                take: input.take,
            }),
        ]);

        return { total, items };
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
