import { randomUUID } from 'node:crypto';
import { Visibility } from '@hitbox/database';
import type { PrismaClient, User } from '@hitbox/database';

/**
 * The local projection of a Clerk account.
 *
 * The shape auth publishes and the shape this table stores are deliberately
 * different, and this repository is where they meet:
 *
 *   auth's payload        →  User column
 *   ────────────────────     ──────────────────────────────────
 *   clerkUserId           →  clerkId
 *   username              →  handle
 *   firstName + lastName  →  fullName   (joined; null when both are empty)
 *   emailVerified         →  (nothing — see the adapter's note)
 *
 * Auth's contract is Clerk-shaped because that is what a Clerk webhook
 * carries; translating here is the point of the port, not a leak across it.
 */

/** What auth's UserRegisteredPayload gives us, unchanged. */
export interface ClerkUserSnapshot {
    clerkUserId: string;
    email: string;
    emailVerified: boolean;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
}

/** Columns a user may edit on their own profile. */
export interface UpdateProfileData {
    handle?: string | undefined;
    fullName?: string | undefined;
    avatarUrl?: string | undefined;
    bio?: string | undefined;
    phone?: string | undefined;
    generalLocation?: string | undefined;
    profileVisibility?: Visibility | undefined;
}

/** `first` + `last` → `fullName`, or null when Clerk sent neither. */
function composeFullName(first: string | null, last: string | null): string | null {
    const joined = [first, last].filter(Boolean).join(' ').trim();
    return joined.length > 0 ? joined : null;
}

export class UserRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { id } });
    }

    findByClerkId(clerkId: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { clerkId } });
    }

    async existsByEmail(email: string): Promise<boolean> {
        const user = await this.prisma.user.findUnique({
            where: { email },
            select: { id: true },
        });
        return user !== null;
    }

    /**
     * Idempotent projection of a Clerk user — safe under webhook replays.
     *
     * Matches on clerkId OR email, so a Clerk user whose email already has a
     * local row (from earlier provisioning, or the demo seed) links to that row
     * instead of colliding on the unique email.
     *
     * The table declares no column defaults, so a create supplies every
     * required field explicitly — id, role, visibility, active flag and both
     * timestamps.
     */
    async upsertFromClerk(data: ClerkUserSnapshot): Promise<User> {
        const now = new Date();
        const mutable = {
            email: data.email,
            handle: data.username,
            fullName: composeFullName(data.firstName, data.lastName),
            avatarUrl: data.avatarUrl,
        };

        const existing = await this.prisma.user.findFirst({
            where: { OR: [{ clerkId: data.clerkUserId }, { email: data.email }] },
            select: { id: true },
        });

        if (existing) {
            return this.prisma.user.update({
                where: { id: existing.id },
                data: {
                    clerkId: data.clerkUserId,
                    ...mutable,
                    updatedAt: now,
                    // A returning user is reinstated: Clerk would not have sent
                    // this event for an account it considers gone.
                    isActive: true,
                    deactivatedAt: null,
                    archivedAt: null,
                },
            });
        }

        return this.prisma.user.create({
            data: {
                id: randomUUID(),
                clerkId: data.clerkUserId,
                ...mutable,
                phone: null,
                bio: null,
                role: 'USER',
                // Private by default — a new account opts in to being public,
                // it is never opted in on their behalf.
                profileVisibility: Visibility.PRIVATE,
                generalLocation: null,
                preferredMarketId: null,
                isActive: true,
                deactivatedAt: null,
                archivedAt: null,
                createdAt: now,
                updatedAt: now,
            },
        });
    }

    /**
     * Soft delete on `user.deleted` from Clerk.
     *
     * `archivedAt` is the tombstone the rest of the platform reads; `isActive`
     * and `deactivatedAt` are set alongside it so a query that filters on
     * either one agrees with the others. The row itself stays — orders,
     * claims and audit rows reference it.
     */
    async softDeleteByClerkId(clerkId: string): Promise<void> {
        const now = new Date();
        await this.prisma.user.updateMany({
            where: { clerkId, archivedAt: null },
            data: {
                archivedAt: now,
                deactivatedAt: now,
                isActive: false,
                updatedAt: now,
            },
        });
    }

    updateProfile(id: string, data: UpdateProfileData): Promise<User> {
        return this.prisma.user.update({
            where: { id },
            data: { ...data, updatedAt: new Date() },
        });
    }
}
