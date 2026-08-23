/**
 * Authorization seeder CLI.
 *
 *   pnpm --filter @hitbox/authz seed
 *   pnpm authz:seed                    (from the repo root)
 *
 * Run it after every deploy that touches the permission or role catalog, and
 * once after applying the authorization migration. It is idempotent.
 *
 * Optional: grant the break-glass role to a real account, by email.
 *   pnpm authz:seed -- --super-admin=ops@hitbox.com
 * This is the ONLY sanctioned way to bootstrap the first SUPER_ADMIN, because
 * the API path deliberately refuses to let anyone create one out of nothing.
 */
import { prisma } from '@hitbox/database';
import { getRedis } from '@hitbox/shared';
import { AUTHZ_CACHE } from '../src/constants/authz.constant';
import { ROLE_KEYS } from '../src/domain/catalog/role-catalog';
import { seedAuthorization } from '../src/seed/seed-authorization';

function argValue(name: string): string | null {
    const prefix = `--${name}=`;
    const hit = process.argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
}

async function grantSuperAdmin(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
        throw new Error(
            `No platform account for "${email}" — the person must sign in through Clerk at least once first.`,
        );
    }

    const role = await prisma.role.findUnique({
        where: { key: ROLE_KEYS.SUPER_ADMIN },
        select: { id: true },
    });
    if (!role) throw new Error('SUPER_ADMIN role missing — seeding failed.');

    const existing = await prisma.userRoleAssignment.findFirst({
        where: { userId: user.id, roleId: role.id, organizationId: null },
        select: { id: true },
    });
    if (existing) {
        console.log(`  • ${email} already holds SUPER_ADMIN`);
        return;
    }

    await prisma.userRoleAssignment.create({
        data: { userId: user.id, roleId: role.id, organizationId: null, grantedById: null },
    });
    await prisma.auditLog.create({
        data: {
            actorUserId: null,
            actorType: 'SYSTEM',
            action: 'role:assign',
            resource: 'role',
            resourceId: role.id,
            result: 'SUCCESS',
            metadata: {
                roleKey: ROLE_KEYS.SUPER_ADMIN,
                targetUserId: user.id,
                reason: 'bootstrapped via authz seeder CLI',
            },
        },
    });
    console.log(`  ✔ granted SUPER_ADMIN to ${email}`);
}

/**
 * Bump the cache epoch so every instance drops its cached snapshots. Without
 * this, a role whose permissions just changed would keep using the old set
 * until the L2 TTL expired.
 */
async function invalidatePermissionCache(): Promise<void> {
    const redis = getRedis();
    if (!redis) {
        console.log('  • REDIS_URL unset — nothing to invalidate');
        return;
    }
    const epoch = await redis.incr(AUTHZ_CACHE.EPOCH_KEY);
    await redis.publish('authz:invalidate', '*');
    console.log(`  ✔ permission cache epoch bumped to ${epoch}`);
    redis.disconnect();
}

async function main(): Promise<void> {
    console.log('Seeding authorization catalog...');
    const report = await seedAuthorization(prisma);

    console.log(
        `  permissions: +${report.permissionsCreated} created, ~${report.permissionsUpdated} updated`,
    );
    console.log(`  roles:       +${report.rolesCreated} created, ~${report.rolesUpdated} updated`);
    console.log(
        `  grants:      +${report.grantsAdded.length} added, -${report.grantsRemoved.length} removed`,
    );

    // Print the grant diff in full: a change in what a role can do is the most
    // security-relevant thing this script does, so it must never be silent.
    for (const grant of report.grantsAdded) {
        console.log(`    + ${grant.role} <- ${grant.permission}`);
    }
    for (const grant of report.grantsRemoved) {
        console.log(`    - ${grant.role} -x- ${grant.permission}`);
    }

    if (report.permissionsOrphaned.length > 0) {
        console.log(
            `  ! ${report.permissionsOrphaned.length} permission(s) in the database are no longer in the catalog:`,
        );
        for (const key of report.permissionsOrphaned) console.log(`      ${key}`);
        console.log('    They were NOT deleted. Remove them with a deliberate migration.');
    }

    if (report.usersBackfilledWithDefaultRole > 0) {
        console.log(
            `  ✔ backfilled ${report.usersBackfilledWithDefaultRole} existing user(s) with the USER role`,
        );
    }

    const superAdminEmail = argValue('super-admin');
    if (superAdminEmail) await grantSuperAdmin(superAdminEmail);

    await invalidatePermissionCache();
    console.log('Done.');
}

main()
    .catch((error: unknown) => {
        console.error('Authorization seeding failed:', error);
        process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
