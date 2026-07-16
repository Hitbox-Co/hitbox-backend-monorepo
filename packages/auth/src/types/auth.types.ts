import type { UserRole } from '../domain/enums/user-role.enum';

/**
 * The authenticated principal attached to `req.auth` by the auth middleware.
 * Downstream modules should depend on this type — never on Clerk directly.
 */
export interface AuthContext {
    accountId: string;
    clerkUserId: string;
    email: string;
    role: UserRole;
    sessionId: string | null;
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
