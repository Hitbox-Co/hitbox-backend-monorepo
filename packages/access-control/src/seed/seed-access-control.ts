import type { PrismaClient } from '@hitbox/database';
import { ROLE_CATALOG } from '../domain/role-catalog';
import { PermissionRepository } from '../repository/permission.repository';
import { RoleRepository } from '../repository/role.repository';

export interface SeedResult {
    permissions: { created: number; updated: number; deactivated: number };
    roles: { created: number; updated: number };
}

/**
 * Seeds the permission catalog and the twelve system roles.
 *
 * Idempotent — safe to run on every deploy, which is the point: the code
 * catalog is the authority, so re-running reconciles any drift in the
 * database back to it. Operator-defined roles (`isSystem = false`) are never
 * touched.
 *
 * Deliberately does NOT create any role assignment. Bootstrapping the first
 * administrator is a one-off operational act, not something a seed should do
 * silently on every deploy — see docs/authorization-architecture.md.
 */
export async function seedAccessControl(prisma: PrismaClient): Promise<SeedResult> {
    const permissionRepo = new PermissionRepository(prisma);
    const roleRepo = new RoleRepository(prisma);

    const permissions = await permissionRepo.syncCatalog();

    // Resolve every catalog key to its row id once, rather than per role.
    const rows = await permissionRepo.findAll();
    const idByKey = new Map(rows.map((row) => [row.key, row.id]));

    let created = 0;
    let updated = 0;

    for (const role of ROLE_CATALOG) {
        const permissionIds = role.permissions.map((key) => {
            const id = idByKey.get(key);
            if (!id) {
                // Unreachable in practice: role-catalog.ts asserts at import
                // time that every key is in the catalog, and syncCatalog just
                // wrote the catalog. Explicit anyway — a silent skip here
                // would ship a role with missing permissions.
                throw new Error(
                    `Permission "${key}" required by role ${role.name} was not found after catalog sync.`,
                );
            }
            return id;
        });

        const result = await roleRepo.upsertSystemRole({
            name: role.name,
            displayName: role.displayName,
            entityGroup: role.entityGroup,
            domain: role.domain,
            permissionIds,
        });
        if (result.created) created += 1;
        else updated += 1;
    }

    return { permissions, roles: { created, updated } };
}
