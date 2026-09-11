import { AccountStatus, UserRole } from '@hitbox/auth';
import type { AccountSnapshot, IAccountLookup } from '@hitbox/auth';
import type { UserRepository } from '../repository/user.repository';

/**
 * Users-side implementation of the auth module's `IAccountLookup` port.
 *
 * Auth asks one question on every authenticated request — "who is this Clerk
 * subject locally, and may they proceed?" — and this is the only place that
 * answers it. Auth never sees a `User` row.
 */
export class UserAccountLookup implements IAccountLookup {
    constructor(private readonly users: UserRepository) { }

    async findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null> {
        const user = await this.users.findByClerkId(clerkUserId);
        if (!user) return null;

        return {
            id: user.id,
            email: user.email,
            role: user.role as unknown as UserRole, // Prisma + domain enums share string values
            status: toAccountStatus(user),
            /**
             * ⚠ No longer derived from the database.
             *
             * The schema decomposition dropped `User.emailVerified`, so there
             * is nothing left to read. Clerk does not mint a session before the
             * primary email is verified, which was always the real gate — this
             * column only ever backed a defence-in-depth second check in
             * `requireAuth`, and that second check is now effectively disabled.
             *
             * To restore it, add `emailVerified Boolean` to
             * packages/users/prisma/users.prisma and map
             * `UserRegisteredPayload.emailVerified` onto it in the repository;
             * auth needs no change, because the port already carries the field.
             */
            emailVerified: true,
        };
    }

    emailExists(email: string): Promise<boolean> {
        return this.users.existsByEmail(email);
    }
}

/**
 * Maps the row's lifecycle columns onto the three states auth understands.
 *
 * Note the schema no longer distinguishes "suspended by staff" from
 * "deactivated by the user" — both are `isActive = false`. Both are reported
 * as SUSPENDED, which fails closed: a deactivated account is refused rather
 * than admitted. If the two ever need different handling, they need different
 * columns first.
 */
function toAccountStatus(user: {
    isActive: boolean;
    archivedAt: Date | null;
}): AccountStatus {
    if (user.archivedAt !== null) return AccountStatus.DELETED;
    if (!user.isActive) return AccountStatus.SUSPENDED;
    return AccountStatus.ACTIVE;
}
