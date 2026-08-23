import type { PrismaClient } from '@hitbox/database';
import { assertCatalogIsSound } from '../domain/catalog/catalog-validation';
import { PERMISSION_CATALOG } from '../domain/catalog/permission-catalog';
import { ROLE_CATALOG } from '../domain/catalog/role-catalog';
import { DEFAULT_PLATFORM_ROLE } from '../domain/catalog/role-catalog';
import { formatPermissionKey } from '../domain/permission-key';

export interface SeedReport {
    permissionsCreated: number;
    permissionsUpdated: number;
    /** In the catalog no more — reported, never auto-deleted. See below. */
    permissionsOrphaned: string[];
    rolesCreated: number;
    rolesUpdated: number;
    grantsAdded: { role: string; permission: string }[];
    grantsRemoved: { role: string; permission: string }[];
    usersBackfilledWithDefaultRole: number;
}

/**
 * RECONCILES the code-owned catalog into the database. Idempotent: running it
 * twice changes nothing the second time, so it is safe in a deploy pipeline.
 *
 * Design decisions worth knowing:
 *
 *  - The catalog is validated BEFORE any write. A malformed role definition can
 *    therefore never reach the database, so it can never widen access.
 *
 *  - Permissions and roles are upserted; role-permission links are diffed, so
 *    REMOVING a permission from a role in code actually removes the grant. A
 *    seeder that only ever adds would silently accumulate privilege.
 *
 *  - Permissions that exist in the database but no longer in the catalog are
 *    REPORTED, not deleted. Deleting one would cascade its grants away, and a
 *    catalog edited on a branch must not be able to silently strip access in
 *    production. Removal is a deliberate, separate migration.
 *
 *  - Every existing user without the baseline platform role is backfilled, so
 *    the switch from the legacy `User.role` column to real role assignments
 *    does not lock anybody out.
 *
 *  - Callers must invalidate the permission cache afterwards (the CLI wrapper
 *    does; see scripts/seed-authz.ts) because role contents may have changed.
 */
export async function seedAuthorization(prisma: PrismaClient): Promise<SeedReport> {
    assertCatalogIsSound();

    const report: SeedReport = {
        permissionsCreated: 0,
        permissionsUpdated: 0,
        permissionsOrphaned: [],
        rolesCreated: 0,
        rolesUpdated: 0,
        grantsAdded: [],
        grantsRemoved: [],
        usersBackfilledWithDefaultRole: 0,
    };

    // ------------------------------------------------------- 1. permissions
    const permissionIdByKey = new Map<string, string>();

    for (const definition of PERMISSION_CATALOG) {
        const key = formatPermissionKey(definition);
        const where = {
            resource_action_scope: {
                resource: definition.resource,
                action: definition.action,
                scope: definition.scope,
            },
        };

        const existing = await prisma.permission.findUnique({ where });

        if (existing) {
            const changed =
                existing.description !== definition.description ||
                existing.isSensitive !== definition.sensitive;

            const row = changed
                ? await prisma.permission.update({
                    where,
                    data: {
                        description: definition.description,
                        isSensitive: definition.sensitive,
                    },
                })
                : existing;

            if (changed) report.permissionsUpdated += 1;
            permissionIdByKey.set(key, row.id);
        } else {
            const row = await prisma.permission.create({
                data: {
                    resource: definition.resource,
                    action: definition.action,
                    scope: definition.scope,
                    description: definition.description,
                    isSensitive: definition.sensitive,
                },
            });
            report.permissionsCreated += 1;
            permissionIdByKey.set(key, row.id);
        }
    }

    // Report-only: never auto-delete (see the note above).
    const allPermissionRows = await prisma.permission.findMany({
        select: { resource: true, action: true, scope: true },
    });
    for (const row of allPermissionRows) {
        const key = `${row.resource}:${row.action}:${row.scope.toLowerCase()}`;
        if (!permissionIdByKey.has(key)) report.permissionsOrphaned.push(key);
    }

    // ------------------------------------------------------------- 2. roles
    for (const definition of ROLE_CATALOG) {
        const existing = await prisma.role.findUnique({ where: { key: definition.key } });

        const data = {
            name: definition.name,
            description: definition.description,
            kind: definition.kind,
            isPrivileged: definition.isPrivileged,
            isSystemManaged: true,
        };

        const role = existing
            ? await prisma.role.update({ where: { key: definition.key }, data })
            : await prisma.role.create({ data: { key: definition.key, ...data } });

        if (existing) report.rolesUpdated += 1;
        else report.rolesCreated += 1;

        // --------------------------------------- 3. diff the permission links
        const desiredIds = new Set(
            definition.permissions.flatMap((key) => {
                const id = permissionIdByKey.get(key);
                return id ? [id] : [];
            }),
        );

        const currentLinks = await prisma.rolePermission.findMany({
            where: { roleId: role.id },
            select: { permissionId: true },
        });
        const currentIds = new Set(currentLinks.map((link) => link.permissionId));

        const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));
        const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

        if (toAdd.length > 0) {
            await prisma.rolePermission.createMany({
                data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
                skipDuplicates: true,
            });
        }
        if (toRemove.length > 0) {
            await prisma.rolePermission.deleteMany({
                where: { roleId: role.id, permissionId: { in: toRemove } },
            });
        }

        const keyById = new Map([...permissionIdByKey].map(([key, id]) => [id, key]));
        for (const id of toAdd) {
            report.grantsAdded.push({ role: role.key, permission: keyById.get(id) ?? id });
        }
        for (const id of toRemove) {
            report.grantsRemoved.push({ role: role.key, permission: keyById.get(id) ?? id });
        }
    }

    // --------------------------------- 4. backfill the baseline platform role
    const defaultRole = await prisma.role.findUnique({
        where: { key: DEFAULT_PLATFORM_ROLE },
        select: { id: true },
    });

    if (defaultRole) {
        const usersMissingIt = await prisma.user.findMany({
            where: {
                deletedAt: null,
                roleAssignments: { none: { roleId: defaultRole.id, organizationId: null } },
            },
            select: { id: true },
        });

        if (usersMissingIt.length > 0) {
            await prisma.userRoleAssignment.createMany({
                data: usersMissingIt.map((user) => ({
                    userId: user.id,
                    roleId: defaultRole.id,
                    organizationId: null,
                })),
                skipDuplicates: true,
            });
            report.usersBackfilledWithDefaultRole = usersMissingIt.length;
        }
    }

    return report;
}
