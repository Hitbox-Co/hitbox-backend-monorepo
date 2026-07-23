import type { AccountStatus } from '../enums/account-status.enum';
import type { UserRole } from '../enums/user-role.enum';

/** Minimal account projection the auth middleware needs. */
export interface AccountSnapshot {
    id: string;
    email: string;
    role: UserRole;
    status: AccountStatus;
    emailVerified: boolean;
}

/**
 * Port implemented by the users module and injected at bootstrap.
 * Auth never imports users code directly — when users becomes its own
 * service, this port is re-implemented as an RPC/HTTP client without
 * touching the middleware.
 */
export interface IAccountLookup {
    findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null>;
    /** True if a local account already exists for this email (registration guard). */
    emailExists(email: string): Promise<boolean>;
}
