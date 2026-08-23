// Brings @hitbox/auth's `req.auth` augmentation into this program. Authorization
// reads the principal that authentication attached, so the two declarations must
// be visible together — without this import, `req.auth` is invisible here even
// though it exists at runtime.
import type { AuthContext } from '@hitbox/auth';
import type { AuthzPrincipal } from '../domain/interfaces/principal.interface';

/**
 * Attached to `req.authz` by the authorization middleware. Kept strictly
 * separate from `req.auth` (which answers "who is this?") so the two concerns
 * cannot quietly merge back together.
 */
export interface AuthzContext {
    /** Effective roles/permissions snapshot for the authenticated user. */
    principal: AuthzPrincipal;
    /** The authenticated identity this snapshot was built for. */
    readonly identity?: Pick<AuthContext, 'accountId' | 'clerkUserId'>;
    /** The tenant this request is acting in, or null for a non-tenant request. */
    organizationId: string | null;
    /** Which client application the request arrived from (see API surfaces). */
    surface: string | null;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            authz?: AuthzContext;
        }
    }
}

export { };
