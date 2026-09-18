import type { PrismaClient } from '@hitbox/database';

/**
 * "Does anybody already hold this email address?"
 *
 * The one question this module asks about the users table, and the reason it
 * needs asking: Clerk refuses to invite an address it already knows, and staff
 * frequently already have a HitBox account because they buy things too. So the
 * invitation flow has to know which of its two paths to take before it calls
 * the provider.
 *
 * Read-only and read-narrow — it returns an id and nothing else. Users owns the
 * table and everything about a person; this is a membership test, not a profile
 * lookup, and keeping it to an id means no PII crosses the boundary.
 *
 * `archivedAt` is respected: a tombstoned account does not hold its address for
 * these purposes, so a re-invitation after an offboarding takes the invite path
 * rather than silently granting a role to a dead row.
 */
export class UserDirectoryRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async findActiveByEmail(email: string): Promise<{ id: string } | null> {
        return this.prisma.user.findFirst({
            where: { email: email.toLowerCase(), archivedAt: null },
            select: { id: true },
        });
    }
}
