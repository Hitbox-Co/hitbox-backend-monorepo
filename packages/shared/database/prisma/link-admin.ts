/**
 * Links the seeded HITBOX_SYSTEM_ADMIN row to a real Clerk account.
 *
 *   pnpm db:link-admin -- user_2abcXYZ...            (Clerk user id)
 *   pnpm db:link-admin -- user_2abcXYZ... you@example.com
 *
 * ── Why this script exists ──────────────────────────────────────────────────
 *
 * This backend never stores passwords. Identity lives in Clerk, and the `User`
 * table holds only a local projection keyed by `clerkId`. So a seeded admin row
 * is inert until its `clerkId` matches an account that can actually sign in —
 * `requireAuth` verifies the Clerk JWT, then looks the local row up by the
 * token's subject. No match, no session, regardless of what roles the row holds.
 *
 * Rather than re-running the (destructive) demo seed just to change one column,
 * this updates the admin row in place and leaves every other row untouched.
 *
 * It also re-asserts the HITBOX_SYSTEM_ADMIN assignment, so it doubles as the
 * "I locked myself out" recovery script.
 */
import { randomUUID } from 'node:crypto';
import { RoleScopeType } from '@prisma/client';
import { prisma } from '../src/index';

const ADMIN_ROLE = 'HITBOX_SYSTEM_ADMIN';

async function main(): Promise<void> {
    const [clerkId, emailArg] = process.argv.slice(2);

    if (!clerkId || !clerkId.startsWith('user_')) {
        console.error(
            'Usage: pnpm db:link-admin -- <clerkUserId> [email]\n\n' +
            'The Clerk user id starts with "user_". Find it in the Clerk\n' +
            'Dashboard under Users, or in the JWT\'s `sub` claim.',
        );
        process.exitCode = 1;
        return;
    }

    // Prefer the row the demo seed created; fall back to matching on email so
    // this also works against a database seeded some other way.
    const existing = await prisma.user.findFirst({
        where: emailArg
            ? { OR: [{ clerkId }, { email: emailArg }] }
            : { OR: [{ clerkId }, { email: 'admin@hitbox.demo' }] },
    });

    if (!existing) {
        console.error(
            'No admin user row found. Run `pnpm db:seed:demo` first, or pass the\n' +
            'email of an existing user as the second argument.',
        );
        process.exitCode = 1;
        return;
    }

    const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
            clerkId,
            ...(emailArg ? { email: emailArg } : {}),
            isActive: true,
            deactivatedAt: null,
            archivedAt: null,
            updatedAt: new Date(),
        },
    });

    const role = await prisma.role.findUnique({ where: { name: ADMIN_ROLE } });
    if (!role) {
        console.error(`Role ${ADMIN_ROLE} not found. Run \`pnpm db:seed:authz\` first.`);
        process.exitCode = 1;
        return;
    }

    const live = await prisma.roleAssignment.findFirst({
        where: {
            userId: user.id,
            roleId: role.id,
            scopeType: RoleScopeType.GLOBAL,
            revokedAt: null,
        },
    });

    if (!live) {
        await prisma.roleAssignment.create({
            data: {
                id: randomUUID(),
                userId: user.id,
                roleId: role.id,
                scopeType: RoleScopeType.GLOBAL,
                scopeId: null,
                // Self-granted: this is the bootstrap assignment, and there is
                // by definition no prior administrator to attribute it to.
                grantedById: user.id,
                grantedAt: new Date(),
                revokedAt: null,
            },
        });
    }

    console.log('✔ admin linked');
    console.log(`  userId    ${user.id}`);
    console.log(`  clerkId   ${user.clerkId}`);
    console.log(`  email     ${user.email}`);
    console.log(`  role      ${ADMIN_ROLE} (GLOBAL)${live ? ' — already held' : ' — granted'}`);
    console.log('\nSign in through Clerk as that account, then GET /api/v1/authz/me.');
}

main()
    .catch((error) => {
        console.error('✖ link failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
