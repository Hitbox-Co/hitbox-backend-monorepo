import { MembershipStatus, OrganizationStatus } from '@hitbox/database';
import type { Prisma, PrismaClient } from '@hitbox/database';
import { PermissionScope } from '../domain/enums/permission-scope.enum';
import { RoleKind } from '../domain/enums/role-kind.enum';
import type {
    AuthzPrincipal,
    OrganizationSummary,
    PermissionGrant,
} from '../domain/interfaces/principal.interface';

export interface RoleSummary {
    id: string;
    key: string;
    name: string;
    description: string | null;
    kind: RoleKind;
    isPrivileged: boolean;
    isSystemManaged: boolean;
    permissionKeys: string[];
}

export interface AssignmentRecord {
    id: string;
    userId: string;
    roleId: string;
    roleKey: string;
    roleKind: RoleKind;
    isPrivileged: boolean;
    organizationId: string | null;
    grantedById: string | null;
    grantedAt: Date;
    expiresAt: Date | null;
}

/** Only live assignments count: unexpired, and inside a usable tenant. */
const notExpired = (now: Date): Prisma.UserRoleAssignmentWhereInput => ({
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export class AuthzRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Builds the complete authorization snapshot for a user in ONE round trip.
     *
     * Correctness notes:
     *  - expired assignments are filtered in SQL, not in JS, so a stale row can
     *    never widen access even if the sweeper job is behind;
     *  - an organization-scoped assignment is only honoured when the user still
     *    has an ACTIVE membership in an ACTIVE, non-deleted organization. Role
     *    assignment alone is not enough — removing someone from a tenant
     *    immediately removes every capability they had inside it.
     */
    async loadPrincipal(userId: string): Promise<AuthzPrincipal> {
        const now = new Date();

        const [assignments, memberships] = await Promise.all([
            this.prisma.userRoleAssignment.findMany({
                where: { userId, ...notExpired(now) },
                select: {
                    organizationId: true,
                    role: {
                        select: {
                            key: true,
                            kind: true,
                            permissions: {
                                select: {
                                    permission: {
                                        select: {
                                            resource: true,
                                            action: true,
                                            scope: true,
                                            isSensitive: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            this.prisma.organizationMembership.findMany({
                where: {
                    userId,
                    status: MembershipStatus.ACTIVE,
                    organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
                },
                select: {
                    organizationId: true,
                    organization: { select: { id: true, slug: true, name: true } },
                },
            }),
        ]);

        const activeOrgIds = new Set(memberships.map((membership) => membership.organizationId));

        const platformRoles: string[] = [];
        const rolesByOrg = new Map<string, string[]>();
        const grants: PermissionGrant[] = [];
        // Dedupe identical grants arriving from two different roles.
        const seenGrants = new Set<string>();

        for (const assignment of assignments) {
            const { organizationId, role } = assignment;

            if (organizationId === null) {
                platformRoles.push(role.key);
            } else {
                // Drop assignments for tenants the user is no longer active in.
                if (!activeOrgIds.has(organizationId)) continue;
                const existing = rolesByOrg.get(organizationId);
                if (existing) existing.push(role.key);
                else rolesByOrg.set(organizationId, [role.key]);
            }

            for (const { permission } of role.permissions) {
                const dedupeKey = `${permission.resource}:${permission.action}:${permission.scope}:${organizationId ?? ''}`;
                if (seenGrants.has(dedupeKey)) continue;
                seenGrants.add(dedupeKey);

                grants.push({
                    resource: permission.resource,
                    action: permission.action,
                    // Prisma enum and domain enum share string values.
                    scope: permission.scope as unknown as PermissionScope,
                    organizationId,
                    sensitive: permission.isSensitive,
                });
            }
        }

        const organizations: OrganizationSummary[] = memberships.map((membership) => ({
            id: membership.organization.id,
            slug: membership.organization.slug,
            name: membership.organization.name,
            roles: rolesByOrg.get(membership.organizationId) ?? [],
        }));

        return {
            userId,
            platformRoles: [...new Set(platformRoles)].sort(),
            organizations,
            grants,
            builtAt: Date.now(),
        };
    }

    // ------------------------------------------------------------- catalog reads

    async listRoles(kind?: RoleKind): Promise<RoleSummary[]> {
        const roles = await this.prisma.role.findMany({
            where: kind ? { kind } : undefined,
            orderBy: [{ kind: 'asc' }, { key: 'asc' }],
            include: { permissions: { include: { permission: true } } },
        });

        return roles.map((role) => ({
            id: role.id,
            key: role.key,
            name: role.name,
            description: role.description,
            kind: role.kind as unknown as RoleKind,
            isPrivileged: role.isPrivileged,
            isSystemManaged: role.isSystemManaged,
            permissionKeys: role.permissions
                .map(
                    ({ permission }) =>
                        `${permission.resource}:${permission.action}:${permission.scope.toLowerCase()}`,
                )
                .sort(),
        }));
    }

    async findRoleByKey(key: string): Promise<RoleSummary | null> {
        const roles = await this.listRoles();
        return roles.find((role) => role.key === key) ?? null;
    }

    listPermissions() {
        return this.prisma.permission.findMany({
            orderBy: [{ resource: 'asc' }, { action: 'asc' }, { scope: 'asc' }],
        });
    }

    // -------------------------------------------------------- assignment writes

    async listAssignmentsForUser(
        userId: string,
        organizationId?: string | null,
    ): Promise<AssignmentRecord[]> {
        const rows = await this.prisma.userRoleAssignment.findMany({
            where: {
                userId,
                ...(organizationId === undefined ? {} : { organizationId }),
            },
            include: { role: true },
            orderBy: { grantedAt: 'desc' },
        });

        return rows.map((row) => ({
            id: row.id,
            userId: row.userId,
            roleId: row.roleId,
            roleKey: row.role.key,
            roleKind: row.role.kind as unknown as RoleKind,
            isPrivileged: row.role.isPrivileged,
            organizationId: row.organizationId,
            grantedById: row.grantedById,
            grantedAt: row.grantedAt,
            expiresAt: row.expiresAt,
        }));
    }

    /**
     * Idempotent grant. The two partial unique indexes added in the migration
     * make a duplicate impossible at the database level; this findFirst keeps
     * the API from returning a 500 on a repeated click.
     */
    async grantRole(input: {
        userId: string;
        roleId: string;
        organizationId: string | null;
        grantedById: string | null;
        expiresAt: Date | null;
    }): Promise<{ id: string; created: boolean }> {
        const existing = await this.prisma.userRoleAssignment.findFirst({
            where: {
                userId: input.userId,
                roleId: input.roleId,
                organizationId: input.organizationId,
            },
            select: { id: true },
        });

        if (existing) {
            // Refresh the expiry window on a re-grant rather than erroring.
            await this.prisma.userRoleAssignment.update({
                where: { id: existing.id },
                data: { expiresAt: input.expiresAt, grantedById: input.grantedById },
            });
            return { id: existing.id, created: false };
        }

        const created = await this.prisma.userRoleAssignment.create({
            data: {
                userId: input.userId,
                roleId: input.roleId,
                organizationId: input.organizationId,
                grantedById: input.grantedById,
                expiresAt: input.expiresAt,
            },
            select: { id: true },
        });
        return { id: created.id, created: true };
    }

    async revokeRole(input: {
        userId: string;
        roleId: string;
        organizationId: string | null;
    }): Promise<number> {
        const result = await this.prisma.userRoleAssignment.deleteMany({
            where: {
                userId: input.userId,
                roleId: input.roleId,
                organizationId: input.organizationId,
            },
        });
        return result.count;
    }

    /** Housekeeping for the scheduled sweeper — expired rows are already
     *  ignored by loadPrincipal, this just keeps the table small. */
    async deleteExpiredAssignments(now = new Date()): Promise<number> {
        const result = await this.prisma.userRoleAssignment.deleteMany({
            where: { expiresAt: { not: null, lte: now } },
        });
        return result.count;
    }

    /** Every user holding a role — used to invalidate caches after a role's
     *  permission set changes. */
    async listUserIdsWithRole(roleId: string): Promise<string[]> {
        const rows = await this.prisma.userRoleAssignment.findMany({
            where: { roleId },
            select: { userId: true },
            distinct: ['userId'],
        });
        return rows.map((row) => row.userId);
    }
}
