/**
 * Repairs artists who were provisioned without an organization.
 *
 *   pnpm db:repair:artist-orgs           # report only
 *   pnpm db:repair:artist-orgs --apply   # make the changes
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * The `ARTIST` role's working capabilities are all organization-scoped:
 *
 *     drop:manage:organization
 *     release-approval:read:organization
 *     release-approval:approve:organization
 *
 * The authorization engine satisfies an organization-scoped grant only through
 * an assignment that names an organization. An assignment with a null `scopeId`
 * is rejected outright — *"organization-scoped assignment of ARTIST has no
 * organization id"* — no matter what context the request supplies.
 *
 * `StaffInvitationService` defaulted a `brand_artist` role to ORGANIZATION
 * scope, but the caller could override `scopeType`, and an explicit `OWN`
 * passed straight through. That produced an invitation with no organization,
 * which `ArtistProvisioningService` faithfully copied onto the artist row
 * (`organizationId: event.organizationId`), and any drop created afterwards
 * inherited the same nothing.
 *
 * Nothing failed at invite time. It failed days later as an artist dashboard
 * with no drops, no approval queue and a 403 where the earnings should be.
 *
 * The invite path is fixed (see `ISoloOrganizations`), so this is only for
 * artists provisioned before that fix.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * For every artist with no organization that is linked to a user holding an
 * ARTIST assignment:
 *
 *   1. creates an `ARTIST_INDIVIDUAL` organization — the shape the platform
 *      already uses for a self-releasing artist;
 *   2. points the artist row at it;
 *   3. re-scopes the role assignment to ORGANIZATION on it;
 *   4. adopts the artist's own org-less drops into it, so the drops and the
 *      approvals waiting on them become reachable.
 *
 * Idempotent: the organization is keyed by a hash of the artist id, and every
 * write is skipped when it is already correct. The `StaffInvitation` row is
 * deliberately **not** rewritten — it records what was actually invited, and
 * editing history to match a repair is how a trail stops being evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { OrganizationType, RoleScopeType } from '@prisma/client';
import { prisma } from '../src/index';

const APPLY = process.argv.includes('--apply');

interface Change {
    artist: string;
    organization: string;
    createdOrganization: boolean;
    reassigned: boolean;
    dropsAdopted: number;
}

async function main(): Promise<void> {
    const broken = await prisma.artist.findMany({
        where: { organizationId: null, userId: { not: null } },
        select: { id: true, name: true, slug: true, userId: true },
    });

    if (broken.length === 0) {
        console.log('✔ no artists are missing an organization');
        return;
    }

    const changes: Change[] = [];

    for (const artist of broken) {
        const assignment = await prisma.roleAssignment.findFirst({
            where: { userId: artist.userId!, revokedAt: null, role: { name: 'ARTIST' } },
            select: { id: true, scopeType: true, scopeId: true },
        });
        if (!assignment) {
            console.log(`  – ${artist.name}: no live ARTIST assignment, skipping`);
            continue;
        }

        // Keyed on the artist, not the name: two artists called "Nova" would
        // otherwise collide on the UNIQUE slug and the second repair would fail.
        const slug = `solo-${createHash('sha1').update(artist.id).digest('hex').slice(0, 12)}`;
        const existing = await prisma.organization.findUnique({
            where: { slug },
            select: { id: true, name: true },
        });

        const orgLessDrops = await prisma.drop.count({
            where: { artistId: artist.id, organizationId: null },
        });

        const change: Change = {
            artist: artist.name,
            organization: existing?.name ?? artist.name,
            createdOrganization: !existing,
            reassigned:
                assignment.scopeType !== RoleScopeType.ORGANIZATION || !assignment.scopeId,
            dropsAdopted: orgLessDrops,
        };
        changes.push(change);

        if (!APPLY) continue;

        const now = new Date();
        const organizationId =
            existing?.id ??
            (
                await prisma.organization.create({
                    data: {
                        id: randomUUID(),
                        name: artist.name,
                        slug,
                        type: OrganizationType.ARTIST_INDIVIDUAL,
                        isActive: true,
                        createdAt: now,
                        updatedAt: now,
                    },
                    select: { id: true },
                })
            ).id;

        await prisma.$transaction([
            prisma.artist.update({
                where: { id: artist.id },
                data: { organizationId, updatedAt: now },
            }),
            prisma.roleAssignment.update({
                where: { id: assignment.id },
                data: { scopeType: RoleScopeType.ORGANIZATION, scopeId: organizationId },
            }),
            prisma.drop.updateMany({
                where: { artistId: artist.id, organizationId: null },
                data: { organizationId },
            }),
        ]);
    }

    console.log(`\n${APPLY ? 'Repaired' : 'Would repair'} ${changes.length} artist(s):`);
    for (const c of changes) {
        console.log(
            `  ${c.artist}: organization "${c.organization}"` +
            `${c.createdOrganization ? ' (created)' : ' (existing)'}` +
            `${c.reassigned ? ', assignment re-scoped to ORGANIZATION' : ''}` +
            `${c.dropsAdopted > 0 ? `, ${c.dropsAdopted} drop(s) adopted` : ''}`,
        );
    }
    if (!APPLY) console.log('\nNothing was written. Re-run with --apply to make these changes.');
}

main()
    .catch((error) => {
        console.error('✖ repair failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
