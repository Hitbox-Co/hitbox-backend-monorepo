import { AccountStatus, UserRole } from '@hitbox/auth';
import type { AccountSnapshot, IAccountLookup, UserRegisteredPayload } from '@hitbox/auth';
import { UserState } from '@hitbox/database';
import type { User } from '@hitbox/database';
import type { UserRepository } from '../repository/user.repository';

/**
 * Users-side implementation of the auth module's IAccountLookup port.
 * Derives the auth-facing AccountStatus from `state` + `deletedAt`.
 */
export class UserAccountLookup implements IAccountLookup {
    constructor(private readonly users: UserRepository) { }

    async findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null> {
        const user = await this.users.findByClerkUserId(clerkUserId);
        return user ? toSnapshot(user) : null;
    }

    /** JIT path: same idempotent upsert the user.created webhook uses. */
    async provisionFromClerk(payload: UserRegisteredPayload): Promise<AccountSnapshot | null> {
        const user = await this.users.upsertFromClerk(payload);
        return toSnapshot(user);
    }
}

function toSnapshot(user: User): AccountSnapshot {
    const status = user.deletedAt
        ? AccountStatus.DELETED
        : user.state === UserState.SUSPENDED
            ? AccountStatus.SUSPENDED
            : AccountStatus.ACTIVE;

    return {
        id: user.id,
        email: user.email,
        role: user.role as unknown as UserRole, // Prisma + domain enums share string values
        status,
    };
}
