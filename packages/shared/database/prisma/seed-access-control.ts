/**
 * Seeds the authorization catalog: every system permission and the twelve
 * system roles, with their grants.
 *
 * Run from the repo root:  pnpm db:seed:authz
 *
 * Idempotent — safe on every deploy. The code-side catalog in
 * @hitbox/access-control is the authority, so re-running reconciles the
 * database back to it. Operator-defined roles (isSystem = false) are left
 * alone, and no role assignment is created (see the bootstrap note in
 * docs/authorization-architecture.md).
 */
import { seedAccessControl } from '@hitbox/access-control';
import { prisma } from '../src/index';

async function main(): Promise<void> {
    const result = await seedAccessControl(prisma);

    console.log('✔ access-control seed complete');
    console.log(
        `  permissions: ${result.permissions.created} created, ` +
        `${result.permissions.updated} updated, ` +
        `${result.permissions.deactivated} deactivated`,
    );
    console.log(`  roles:       ${result.roles.created} created, ${result.roles.updated} updated`);
}

main()
    .catch((error) => {
        console.error('✖ access-control seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
