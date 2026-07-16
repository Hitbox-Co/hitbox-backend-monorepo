import { UserState } from '@hitbox/database';
import type { PrismaClient, User } from '@hitbox/database';

export interface ClerkUserSnapshot {
    clerkUserId: string;
    email: string;
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

    /** Idempotent projection of a Clerk user — safe under webhook replays. */
    upsertFromClerk(data: ClerkUserSnapshot): Promise<User> {
        const fields = {
            email: data.email,
            username: data.username,
            firstName: data.firstName,
            lastName: data.lastName,
            avatarUrl: data.avatarUrl,
        };
        return this.prisma.user.upsert({
            where: { clerkUserId: data.clerkUserId },
            create: { clerkUserId: data.clerkUserId, ...fields },
            update: fields,
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
