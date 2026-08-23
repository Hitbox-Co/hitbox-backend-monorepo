import { AccountStatus } from '@hitbox/auth';
import type { AccountSnapshot, IAccountLookup } from '@hitbox/auth';
import { UserState } from '@hitbox/database';
import type { UserRepository } from '../repository/user.repository';

/**
 * Users-side implementation of the auth module's IAccountLookup port.
 * Derives the auth-facing AccountStatus from `state` + `deletedAt`.
 *
 * Deliberately projects no role: authorization is resolved by @hitbox/authz
 * from the role/permission tables, not carried on the authentication context.
 */
export class UserAccountLookup implements IAccountLookup {
    constructor(private readonly users: UserRepository) { }

    async findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null> {
        const user = await this.users.findByClerkUserId(clerkUserId);
        if (!user) return null;

        const status = user.deletedAt
            ? AccountStatus.DELETED
            : user.state === UserState.SUSPENDED
                ? AccountStatus.SUSPENDED
                : AccountStatus.ACTIVE;

        return {
            id: user.id,
            email: user.email,
            status,
            emailVerified: user.emailVerified,
        };
    }

    emailExists(email: string): Promise<boolean> {
        return this.users.existsByEmail(email);
    }
}
