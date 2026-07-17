import type { UserRegisteredPayload } from '../../events/auth-event.payloads';
import type { AccountStatus } from '../enums/account-status.enum';
import type { UserRole } from '../enums/user-role.enum';

/** Minimal account projection the auth middleware needs. */
export interface AccountSnapshot {
    id: string;
    email: string;
    role: UserRole;
    status: AccountStatus;
}

/**
 * Port implemented by the users module and injected at bootstrap.
 * Auth never imports users code directly — when users becomes its own
 * service, this port is re-implemented as an RPC/HTTP client without
 * touching the middleware.
 */
export interface IAccountLookup {
    findByClerkUserId(clerkUserId: string): Promise<AccountSnapshot | null>;
    /**
     * Upserts the local account from a Clerk snapshot. Used for just-in-time
     * provisioning when a valid session arrives before (or without) the
     * user.created webhook — e.g. local dev, where Clerk can't reach us.
     */
    provisionFromClerk(payload: UserRegisteredPayload): Promise<AccountSnapshot | null>;
}
