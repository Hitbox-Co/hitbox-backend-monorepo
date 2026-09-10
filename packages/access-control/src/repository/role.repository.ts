import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { AuthorizationDomain, PrismaClient } from '@hitbox/database';

const roleInclude = {
    rolePermissions: { include: { permission: true } },
} satisfies Prisma.RoleInclude;

export type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

export class RoleRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findAll(filter: { domain?: AuthorizationDomain } = {}): Promise<RoleWithPermissions[]> {
        return this.prisma.role.findMany({
            where: filter.domain ? { domain: filter.domain } : {},
            include: roleInclude,
            orderBy: [{ domain: 'asc' }, { name: 'asc' }],
        });
    }

    findById(id: string): Promise<RoleWithPermissions | null> {
        return this.prisma.role.findUnique({ where: { id }, include: roleInclude });
    }

    findByName(name: string): Promise<RoleWithPermissions | null> {
        return this.prisma.role.findUnique({ where: { name }, include: roleInclude });
    }

    countAssignments(roleId: string): Promise<number> {
        return this.prisma.roleAssignment.count({
            where: { roleId, revokedAt: null },
        });
    }

    /**
     * Creates a role and its permission grants in one transaction — a role
     * that exists with a half-written permission set is a security hole, so
     * it is all or nothing.
     */
    async create(input: {
        name: string;
        displayName: string;
        entityGroup: string;
        domain: AuthorizationDomain;
        isSystem: boolean;
        permissionIds: string[];
    }): Promise<RoleWithPermissions> {
        const roleId = randomUUID();
        const now = new Date();

        await this.prisma.$transaction([
            this.prisma.role.create({
                data: {
                    id: roleId,
                    name: input.name,
                    displayName: input.displayName,
                    entityGroup: input.entityGroup,
                    domain: input.domain,
                    isSystem: input.isSystem,
                    isActive: true,
                    createdAt: now,
                },
            }),
            ...input.permissionIds.map((permissionId) =>
                this.prisma.rolePermission.create({
                    data: {
                        id: randomUUID(),
                        roleId,
                        permissionId,
                        fieldAllowlist: [],
                        isInferred: false,
                        createdAt: now,
                    },
                }),
            ),
        ]);

        return (await this.findById(roleId))!;
    }

    /** Patches role metadata. Permission sets go through `replacePermissions`. */
    async update(
        id: string,
        patch: { displayName?: string; entityGroup?: string; isActive?: boolean },
    ): Promise<RoleWithPermissions> {
        await this.prisma.role.update({ where: { id }, data: patch });
        return (await this.findById(id))!;
    }

    /**
     * Replaces a role's whole permission set. Delete-then-insert inside one
     * transaction, so the role is never observable with a partial set.
     */
    async replacePermissions(roleId: string, permissionIds: string[]): Promise<RoleWithPermissions> {
        const now = new Date();
        await this.prisma.$transaction([
            this.prisma.rolePermission.deleteMany({ where: { roleId } }),
            ...permissionIds.map((permissionId) =>
                this.prisma.rolePermission.create({
                    data: {
                        id: randomUUID(),
                        roleId,
                        permissionId,
                        fieldAllowlist: [],
                        isInferred: false,
                        createdAt: now,
                    },
                }),
            ),
        ]);
        return (await this.findById(roleId))!;
    }

    async delete(id: string): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
            this.prisma.role.delete({ where: { id } }),
        ]);
    }

    /** Idempotent seed of one catalog role plus its grants. */
    async upsertSystemRole(input: {
        name: string;
        displayName: string;
        entityGroup: string;
        domain: AuthorizationDomain;
        permissionIds: string[];
    }): Promise<{ roleId: string; created: boolean }> {
        const existing = await this.prisma.role.findUnique({ where: { name: input.name } });
        if (!existing) {
            const role = await this.create({ ...input, isSystem: true });
            return { roleId: role.id, created: true };
        }

        await this.prisma.role.update({
            where: { id: existing.id },
            data: {
                displayName: input.displayName,
                entityGroup: input.entityGroup,
                domain: input.domain,
                isSystem: true,
                isActive: true,
            },
        });
        await this.replacePermissions(existing.id, input.permissionIds);
        return { roleId: existing.id, created: false };
    }
}
