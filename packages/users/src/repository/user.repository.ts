import { UserState } from '@hitbox/database';
import type { PrismaClient, User } from '@hitbox/database';

export interface ClerkUserSnapshot {
    clerkUserId: string;
    email: string;
    emailVerified: boolean;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
}

export interface UpdateProfileData {
    username?: string;
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
}

export class UserRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { id } });
    }

    findByClerkUserId(clerkUserId: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { clerkUserId } });
    }

    /**
     * Idempotent projection of a Clerk user — safe under webhook replays.
     * Matches an existing account by clerkUserId OR email, so a Clerk user whose
     * email already has a local row (e.g. from earlier provisioning) is linked
     * to that row instead of hitting the unique-email constraint.
     */
    async upsertFromClerk(data: ClerkUserSnapshot): Promise<User> {
        const fields = {
            email: data.email,
            emailVerified: data.emailVerified,
            username: data.username,
            firstName: data.firstName,
            lastName: data.lastName,
            avatarUrl: data.avatarUrl,
        };

        const existing = await this.prisma.user.findFirst({
            where: { OR: [{ clerkUserId: data.clerkUserId }, { email: data.email }] },
        });

        if (existing) {
            return this.prisma.user.update({
                where: { id: existing.id },
                data: { clerkUserId: data.clerkUserId, ...fields },
            });
        }
        return this.prisma.user.create({
            data: { clerkUserId: data.clerkUserId, ...fields },
        });
    }

    async softDeleteByClerkUserId(clerkUserId: string): Promise<void> {
        await this.prisma.user.updateMany({
            where: { clerkUserId, deletedAt: null },
            data: { deletedAt: new Date(), state: UserState.INACTIVE },
        });
    }

    updateProfile(id: string, data: UpdateProfileData): Promise<User> {
        return this.prisma.user.update({ where: { id }, data });
    }
}
