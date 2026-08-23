import type { AccountStatus } from '../enums/account-status.enum';

/**
 * Minimal account projection the auth middleware needs.
 *
 * Note what is NOT here: roles and permissions. Authentication only decides
 * whether there is a usable account behind the session; @hitbox/authz decides
 * what that account may do, from its own tables.
 */
export interface AccountSnapshot {
    id: string;
    email: string;
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
