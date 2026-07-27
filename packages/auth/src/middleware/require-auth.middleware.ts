import type { Request, RequestHandler } from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { User as ClerkUser } from '@clerk/backend';
import type { Logger } from 'pino';
import { AppError, env } from '@hitbox/shared';
import { AUTH_ERROR_CODES } from '../constants/auth.constant';
import { AccountStatus } from '../domain/enums/account-status.enum';
import type { IAccountLookup } from '../domain/interfaces/account-lookup.interface';
import type { UserRegisteredPayload } from '../events/auth-event.payloads';
import type { AuthContext } from '../types/auth.types';

interface RequireAuthDeps {
    accounts: IAccountLookup;
    logger: Logger;
}

/** Same projection the webhook applies: native attributes win, unsafe_metadata is the fallback. */
function toRegisteredPayload(user: ClerkUser): UserRegisteredPayload | null {
    const primary =
        user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
        user.emailAddresses[0];
    if (!primary) return null;

    const meta = (user.unsafeMetadata ?? {}) as Record<string, unknown>;
    const metaString = (key: string): string | null =>
        typeof meta[key] === 'string' && meta[key] !== '' ? (meta[key] as string) : null;

    return {
        clerkUserId: user.id,
        email: primary.emailAddress,
        username: user.username ?? metaString('username'),
        firstName: user.firstName ?? metaString('firstName'),
        lastName: user.lastName ?? metaString('lastName'),
        avatarUrl: user.imageUrl ?? null,
    };
}

function extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
    // Clerk's browser SDKs send the session token as the __session cookie.
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.__session;
    return cookie ?? null;
}

/**
 * Verifies the Clerk session JWT (networkless), resolves the local account
 * through the injected IAccountLookup port, and attaches `req.auth`.
 */
export function createRequireAuth(deps: RequireAuthDeps): RequestHandler {
    const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(',')
        .map((party) => party.trim())
        .filter(Boolean);

    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

    // TEMPORARY demo auth — never active in production.
    const demoAuthEnabled = env.DEMO_AUTH_ENABLED === 'true' && env.NODE_ENV !== 'production';

    /** Resolve (or JIT-create) a local account for a demo email — no Clerk. */
    async function resolveDemoAccount(email: string) {
        const clerkUserId = `demo_${email}`;
        let account = await deps.accounts.findByClerkUserId(clerkUserId);
        if (!account) {
            account = await deps.accounts.provisionFromClerk({
                clerkUserId,
                email,
                username: email.split('@')[0] ?? null,
                firstName: 'Demo',
                lastName: 'User',
                avatarUrl: null,
            });
        }
        return account;
    }

    /**
     * The session is valid but no local row exists — the user.created webhook
     * hasn't landed (or can't, in local dev). Pull the user from Clerk's API
     * and upsert it so the account exists from the very first request.
     */
    async function provisionAccount(clerkUserId: string) {
        try {
            const clerkUser = await clerk.users.getUser(clerkUserId);
            const snapshot = toRegisteredPayload(clerkUser);
            if (!snapshot) {
                deps.logger.warn({ clerkUserId }, 'jit provisioning skipped — clerk user has no email');
                return null;
            }
            const account = await deps.accounts.provisionFromClerk(snapshot);
            deps.logger.info({ clerkUserId }, 'account provisioned just-in-time from clerk');
            return account;
        } catch (error) {
            deps.logger.error({ clerkUserId, err: error }, 'jit provisioning from clerk failed');
            return null;
        }
    }

    return async (req, _res, next) => {
        try {
            // ── TEMPORARY demo-auth path (X-Demo-User header) ──────────────
            if (demoAuthEnabled) {
                const raw = req.headers['x-demo-user'];
                const demoEmail = (Array.isArray(raw) ? raw[0] : raw)?.trim();
                if (demoEmail) {
                    const account = await resolveDemoAccount(demoEmail);
                    if (account && account.status !== AccountStatus.DELETED) {
                        req.auth = {
                            accountId: account.id,
                            clerkUserId: `demo_${demoEmail}`,
                            email: account.email,
                            role: account.role,
                            sessionId: null,
                        };
                        deps.logger.warn({ demoEmail }, 'authenticated via TEMPORARY demo-auth header');
                        return next();
                    }
                }
            }
            // ───────────────────────────────────────────────────────────────

            const token = extractToken(req);
            if (!token) {
                throw AppError.unauthorized(
                    'Authentication required',
                    AUTH_ERROR_CODES.UNAUTHENTICATED,
                );
            }

            let payload;
            try {
                payload = await verifyToken(token, {
                    secretKey: env.CLERK_SECRET_KEY,
                    ...(authorizedParties?.length ? { authorizedParties } : {}),
                });
            } catch {
                throw AppError.unauthorized(
                    'Invalid or expired token',
                    AUTH_ERROR_CODES.INVALID_TOKEN,
                );
            }

            let account = await deps.accounts.findByClerkUserId(payload.sub);
            if (!account) {
                account = await provisionAccount(payload.sub);
            }
            if (!account || account.status === AccountStatus.DELETED) {
                throw AppError.unauthorized(
                    'No active account for this session',
                    AUTH_ERROR_CODES.ACCOUNT_NOT_FOUND,
                );
            }
            if (account.status === AccountStatus.SUSPENDED) {
                throw AppError.forbidden(
                    'Account suspended',
                    AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
                );
            }

            const auth: AuthContext = {
                accountId: account.id,
                clerkUserId: payload.sub,
                email: account.email,
                role: account.role,
                sessionId: (payload.sid as string | undefined) ?? null,
            };
            req.auth = auth;
            next();
        } catch (error) {
            next(error);
        }
    };
}
