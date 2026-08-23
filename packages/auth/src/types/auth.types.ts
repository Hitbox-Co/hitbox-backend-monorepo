/**
 * The authenticated principal attached to `req.auth` by the auth middleware.
 * Downstream modules should depend on this type — never on Clerk directly.
 *
 * AUTHENTICATION ONLY. There is deliberately no `role` or permission data here:
 * "who is this?" is answered by Clerk plus the local account lookup, while
 * "what may they do?" is answered by @hitbox/authz from the database and lands
 * on `req.authz`. Keeping the two objects apart is what stops authorization
 * data from creeping into the session and going stale.
 */
export interface AuthContext {
    accountId: string;
    clerkUserId: string;
    email: string;
    sessionId: string | null;
    /**
     * Clerk's `fva` claim — factor verification age, in minutes:
     *   [ age of the first factor, age of the second factor ]
     * `-1` in a slot means "not applicable" (e.g. no MFA enrolled).
     *
     * Carried here because it is an authentication fact, but consumed by the
     * authorization layer's step-up gate for sensitive capabilities. Null when
     * the session token does not include the claim.
     */
    factorVerificationAge: [number, number] | null;
}

declare global {
    //   eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

export { };
