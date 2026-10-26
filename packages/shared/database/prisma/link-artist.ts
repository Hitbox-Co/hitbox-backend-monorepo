/**
 * Links an artist profile to a real Clerk account.
 *
 *   pnpm db:link-artist -- user_2abcXYZ... you@example.com kaze
 *   pnpm db:link-artist -- user_2abcXYZ... you@example.com
 *
 * The third argument is the artist's `slug`. Omit it only when the Clerk id or
 * the email already belongs to a user that an Artist row points at.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Identity lives in Clerk; `User` is only a local projection keyed by `clerkId`.
 * A seeded artist is inert until that column matches an account that can sign
 * in — `requireAuth` verifies the Clerk JWT and looks the local row up by the
 * token's subject, so no match means no session no matter what roles the row
 * holds. This is the artist counterpart of `link-admin.ts`, and the same
 * recovery path when someone is locked out.
 *
 * ── The three things that must all line up ──────────────────────────────────
 *
 * An artist who can see their own work needs more than a role. All of these
 * have to agree, and getting any one wrong fails *silently* — as an empty
 * dashboard days later, not an error here:
 *
 *   1. `User.clerkId`      — or they cannot sign in at all.
 *   2. `Artist.userId`     — or `resolveCaller` finds no artist for the account
 *                            and the approval authority rule (`canApprove`
 *                            compares `actor.artistId` to the approval's
 *                            `requiredArtistId`) can never match.
 *   3. A live `ARTIST` assignment **scoped to the artist's organization**.
 *      The role's working capabilities are all organization-scoped
 *      (`drop:manage:organization`, `release-approval:*:organization`), and the
 *      engine refuses an organization-scoped grant whose assignment names no
 *      organization. An `OWN`-scoped or org-less assignment produces an account
 *      that can never open its own drops.
 *
 * So this script asserts all three and prints what it found, rather than
 * updating one column and leaving the other two to chance.
 */
import { randomUUID } from 'node:crypto';
import { RoleScopeType } from '@prisma/client';
import { prisma } from '../src/index';

const ARTIST_ROLE = 'ARTIST';

function usage(): void {
    console.error(
        'Usage: pnpm db:link-artist -- <clerkUserId> <email> [artistSlug]\n\n' +
        'The Clerk user id starts with "user_" — find it in the Clerk Dashboard\n' +
        'under Users, or in the JWT\'s `sub` claim. `artistSlug` identifies which\n' +
        'artist profile to attach the account to (e.g. "kaze"); it is optional\n' +
        'only when the Clerk id or email already belongs to a linked artist.',
    );
}

async function main(): Promise<void> {
    const [clerkId, email, slug] = process.argv.slice(2);

    if (!clerkId || !clerkId.startsWith('user_')) {
        usage();
        process.exitCode = 1;
        return;
    }

    // ── Which artist profile ────────────────────────────────────────────────
    // Named slug wins; otherwise fall back to whichever artist already points
    // at this identity, so a re-run with no slug is a safe no-op.
    const artist = slug
        ? await prisma.artist.findUnique({
            where: { slug },
            include: { organization: { select: { id: true, name: true, type: true } } },
        })
        : await prisma.artist.findFirst({
            where: { user: { OR: [{ clerkId }, ...(email ? [{ email }] : [])] } },
            include: { organization: { select: { id: true, name: true, type: true } } },
        });

    if (!artist) {
        console.error(
            slug
                ? `No artist with slug "${slug}".`
                : 'No artist is linked to that Clerk id or email yet — pass the artist slug as the third argument.',
        );
        const all = await prisma.artist.findMany({ select: { slug: true, name: true } });
        if (all.length) {
            console.error('\nArtists in this database:');
            for (const a of all) console.error(`  ${a.slug.padEnd(24)} ${a.name}`);
        }
        process.exitCode = 1;
        return;
    }

    // An artist with no organization cannot be authorized for anything, so
    // refuse rather than produce an account that looks fine and is not.
    if (!artist.organizationId) {
        console.error(
            `Artist "${artist.name}" has no organization.\n\n` +
            'The ARTIST role\'s capabilities are organization-scoped, so this\n' +
            'account would be unable to open its own drops or the approvals\n' +
            'waiting on it. Run `pnpm db:repair:artist-orgs -- --apply` first.',
        );
        process.exitCode = 1;
        return;
    }

    // ── Which user row ──────────────────────────────────────────────────────
    // Most specific first, same ordering rule as link-admin: the Clerk id is
    // the strongest identity, then the email, then whoever the artist already
    // points at. An argument cannot be both the needle and the new value.
    const existing =
        (await prisma.user.findFirst({ where: { clerkId } })) ??
        (email ? await prisma.user.findFirst({ where: { email } }) : null) ??
        (artist.userId ? await prisma.user.findUnique({ where: { id: artist.userId } }) : null);

    if (!existing) {
        console.error(
            `No user row to link. Artist "${artist.name}" has no account attached and\n` +
            'neither the Clerk id nor the email matches an existing user.',
        );
        process.exitCode = 1;
        return;
    }

    // `Artist.userId` is UNIQUE — one person is one artist. Stealing the
    // account from another profile would silently detach that one, so refuse.
    const clash = await prisma.artist.findFirst({
        where: { userId: existing.id, id: { not: artist.id } },
        select: { name: true, slug: true },
    });
    if (clash) {
        console.error(
            `That account is already the artist "${clash.name}" (${clash.slug}).\n` +
            'One account backs one artist profile; detach it there first.',
        );
        process.exitCode = 1;
        return;
    }

    const previous = { email: existing.email, clerkId: existing.clerkId };

    const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
            clerkId,
            ...(email ? { email } : {}),
            isActive: true,
            deactivatedAt: null,
            archivedAt: null,
            updatedAt: new Date(),
        },
    });

    const linkedNow = artist.userId !== user.id;
    if (linkedNow) {
        await prisma.artist.update({
            where: { id: artist.id },
            data: { userId: user.id, updatedAt: new Date() },
        });
    }

    // ── The role, scoped to the artist's organization ───────────────────────
    const role = await prisma.role.findUnique({ where: { name: ARTIST_ROLE } });
    if (!role) {
        console.error(`Role ${ARTIST_ROLE} not found. Run \`pnpm db:seed:authz\` first.`);
        process.exitCode = 1;
        return;
    }

    const live = await prisma.roleAssignment.findFirst({
        where: { userId: user.id, roleId: role.id, revokedAt: null },
    });

    let roleNote: string;
    if (!live) {
        await prisma.roleAssignment.create({
            data: {
                id: randomUUID(),
                userId: user.id,
                roleId: role.id,
                scopeType: RoleScopeType.ORGANIZATION,
                scopeId: artist.organizationId,
                grantedById: user.id,
                grantedAt: new Date(),
                revokedAt: null,
            },
        });
        roleNote = 'granted';
    } else if (
        live.scopeType !== RoleScopeType.ORGANIZATION ||
        live.scopeId !== artist.organizationId
    ) {
        // An OWN-scoped or wrongly-scoped assignment is the exact shape that
        // satisfies no organization-scoped capability. Correct it in place.
        await prisma.roleAssignment.update({
            where: { id: live.id },
            data: { scopeType: RoleScopeType.ORGANIZATION, scopeId: artist.organizationId },
        });
        roleNote = `re-scoped (was ${live.scopeType}/${live.scopeId ?? 'NULL'})`;
    } else {
        roleNote = 'already held';
    }

    const drops = await prisma.drop.count({ where: { artistId: artist.id } });
    const waiting = await prisma.releaseApproval.count({
        where: { requiredArtistId: artist.id, status: 'PENDING' },
    });

    console.log('✔ artist linked');
    console.log(`  userId        ${user.id}`);
    console.log(
        `  clerkId       ${user.clerkId}` +
        (previous.clerkId !== user.clerkId ? `   (was ${previous.clerkId})` : ''),
    );
    console.log(
        `  email         ${user.email}` +
        (previous.email !== user.email ? `   (was ${previous.email})` : ''),
    );
    console.log(`  artist        ${artist.name} (${artist.slug})${linkedNow ? ' — linked' : ' — already linked'}`);
    console.log(`  organization  ${artist.organization?.name} [${artist.organization?.type}]`);
    console.log(`  role          ${ARTIST_ROLE} (ORGANIZATION) — ${roleNote}`);
    console.log(`  drops         ${drops}`);
    console.log(`  waiting on    ${waiting} approval(s)`);
    console.log('\nSign in through Clerk as that account, then GET /api/v1/authz/me.');
}

main()
    .catch((error) => {
        console.error('✖ link failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
