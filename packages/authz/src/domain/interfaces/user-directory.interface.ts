/** Minimal user facts the authorization module needs. */
export interface DirectoryUser {
    id: string;
    email: string;
    /** True when the account is soft-deleted — such users can never be granted roles. */
    deleted: boolean;
}

/**
 * Port implemented by the users module and injected at bootstrap, exactly like
 * auth's IAccountLookup. Authz never imports users code directly, so when users
 * becomes its own service this port is re-implemented as an RPC client and
 * nothing in the authorization logic changes.
 */
export interface IUserDirectory {
    findById(userId: string): Promise<DirectoryUser | null>;
    findByEmail(email: string): Promise<DirectoryUser | null>;
}
