import type { UserRegisteredPayload } from '../../events/auth-event.payloads';
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
    /**
     * Creates the local account for a Clerk subject that holds a VALID session
     * but has no row yet — the sign-up webhook has not arrived, or never will.
     * Must be idempotent (the webhook may still deliver the same user later) and
     * resolve only once the row exists. Optional so a test harness, or a
     * deployment that relies on the webhook alone, can omit it.
     */
    provisionFromClerk?(payload: UserRegisteredPayload): Promise<AccountSnapshot | null>;
}
