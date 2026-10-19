import { randomUUID } from 'node:crypto';
import type { Permission, PrismaClient } from '@hitbox/database';
import { PERMISSION_CATALOG } from '../domain/permission-catalog';

/**
 * Reads and syncs the `permissions` table. There is no create/update/delete
 * API surface on purpose (§10): the code-side catalog is the authority, and
 * this repository only mirrors it into the database so role_permissions has
 * something to foreign-key against.
 */
export class PermissionRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findAll(): Promise<Permission[]> {
        return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
    }

    findByKeys(keys: string[]): Promise<Permission[]> {
        return this.prisma.permission.findMany({ where: { key: { in: keys } } });
    }

    /**
     * Upserts every catalog permission and deactivates database rows that are
     * no longer in the catalog.
     *
     * Retired permissions are deactivated rather than deleted: role_permissions
     * rows reference them, and a hard delete would either cascade away audit
     * history or fail. `isActive = false` makes them unselectable while the
     * grant history stays readable.
     */
    async syncCatalog(): Promise<{ created: number; updated: number; deactivated: number }> {
        const existing = await this.prisma.permission.findMany();
        const existingByKey = new Map(existing.map((row) => [row.key, row]));
        const catalogKeys = new Set(PERMISSION_CATALOG.map((p) => p.key));

        let created = 0;
        let updated = 0;

        for (const permission of PERMISSION_CATALOG) {
            const row = existingByKey.get(permission.key);
            if (!row) {
                await this.prisma.permission.create({
                    data: {
                        id: randomUUID(),
                        key: permission.key,
                        resource: permission.resource,
                        action: permission.action,
                        scope: permission.scope,
                        domain: permission.domain,
                        description: permission.description,
                        isActive: true,
                        createdAt: new Date(),
                    },
                });
                created += 1;
                continue;
            }

            const drifted =
                row.resource !== permission.resource ||
                row.action !== permission.action ||
                row.scope !== permission.scope ||
                row.domain !== permission.domain ||
                row.description !== permission.description ||
                !row.isActive;

            if (drifted) {
                await this.prisma.permission.update({
                    where: { id: row.id },
                    data: {
                        resource: permission.resource,
                        action: permission.action,
                        scope: permission.scope,
                        domain: permission.domain,
                        description: permission.description,
                        isActive: true,
                    },
                });
                updated += 1;
            }
        }

        const retired = existing.filter((row) => !catalogKeys.has(row.key) && row.isActive);
        for (const row of retired) {
            await this.prisma.permission.update({
                where: { id: row.id },
                data: { isActive: false },
            });
        }

        return { created, updated, deactivated: retired.length };
    }
}
