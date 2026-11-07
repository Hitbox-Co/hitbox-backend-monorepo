import type { Request, RequestHandler } from 'express';
import {createClerkClient, verifyToken } from '@clerk/backend';
import { AppError, createModuleLogger, env } from '@hitbox/shared';
import { AUTH_ERROR_CODES, AUTH_MODULE } from '../constants/auth.constant';
import { AccountStatus } from '../domain/enums/account-status.enum';
import type { AccountSnapshot, IAccountLookup } from '../domain/interfaces/account-lookup.interface';
import type { UserRegisteredPayload } from '../events/auth-event.payloads';
import type { AuthContext } from '../types/auth.types';

interface RequireAuthDeps {
    accounts: IAccountLookup;
    /** Asserted present by createAuthModule — env.CLERK_SECRET_KEY is optional at the shared-schema level. */
    clerkSecretKey: string;
}

/** The few fields of a Clerk user this file reads — structural, so no SDK type leaks out. */
interface ClerkUserLike {
    id: string;
    primaryEmailAddressId?: string | null;
    emailAddresses?: { id: string; emailAddress: string; verification?: { status?: string | null } | null }[];
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    imageUrl?: string | null;
}

/**
 * Clerk user → the payload the sign-up webhook would have produced. Null when
 * there is no verified primary email: the webhook skips those users too, and
 * this must never admit someone the webhook would not.
 */
function toRegisteredPayload(user: ClerkUserLike): UserRegisteredPayload | null {
    const primary = user.emailAddresses?.find((address) => address.id === user.primaryEmailAddressId);
    if (!primary?.emailAddress) return null;
    if (primary.verification?.status !== 'verified') return null;
    return {
        clerkUserId: user.id,
        email: primary.emailAddress,
        emailVerified: true,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatarUrl: user.imageUrl ?? null,
    };
}

/** After a failed attempt, do not call Clerk again for this user for a little while. */
const PROVISION_RETRY_AFTER_MS = 10_000;

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

    const clerk = createClerkClient({ secretKey: deps.clerkSecretKey });
    const logger = createModuleLogger(AUTH_MODULE);

    // Concurrent requests for one new user (the app retries) share one attempt,
    // and a user that cannot be provisioned is not retried on every request.
    const inFlight = new Map<string, Promise<AccountSnapshot | null>>();
    const failedUntil = new Map<string, number>();

    /**
     * A valid session with no local account usually means the sign-up webhook
     * has not arrived (or is not reaching this server). Rather than refuse the
     * user for as long as that lasts, create the account from Clerk's own record
     * of them — the same path the webhook takes, so it is idempotent and a late
     * webhook just updates the row. Runs only AFTER the token verified, and only
     * for a subject with no row at all: a soft-deleted account is never revived.
     */
    const provisionMissingAccount = (clerkUserId: string): Promise<AccountSnapshot | null> => {
        const provision = deps.accounts.provisionFromClerk?.bind(deps.accounts);
        if (!provision) return Promise.resolve(null);
        if ((failedUntil.get(clerkUserId) ?? 0) > Date.now()) return Promise.resolve(null);

        const running = inFlight.get(clerkUserId);
        if (running) return running;

        const attempt = (async () => {
            try {
                const payload = toRegisteredPayload((await clerk.users.getUser(clerkUserId)) as ClerkUserLike);
                if (!payload) {
                    failedUntil.set(clerkUserId, Date.now() + PROVISION_RETRY_AFTER_MS);
                    logger.warn({ clerkUserId }, 'no verified email on the Clerk user — account not provisioned');
                    return null;
                }
                const account = await provision(payload);
                logger.info({ clerkUserId }, 'account provisioned at sign-in (no webhook had created it)');
                return account;
            } catch (error) {
                failedUntil.set(clerkUserId, Date.now() + PROVISION_RETRY_AFTER_MS);
                logger.warn({ clerkUserId, err: error instanceof Error ? error.message : 'unknown' }, 'could not provision account at sign-in');
                return null;
            } finally {
                inFlight.delete(clerkUserId);
            }
        })();
        inFlight.set(clerkUserId, attempt);
        return attempt;
    };


    return async (req, _res, next) => {
        try {
           
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
                    secretKey: deps.clerkSecretKey,
                    ...(authorizedParties?.length ? { authorizedParties } : {}),
                });
            } catch {
                throw AppError.unauthorized(
                    'Invalid or expired token',
                    AUTH_ERROR_CODES.INVALID_TOKEN,
                );
            }

            let account = await deps.accounts.findByClerkUserId(payload.sub);
            if (!account) account = await provisionMissingAccount(payload.sub);
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
            // Defense-in-depth: Clerk only mints a session after email
            // verification, but we also refuse protected routes for any
            // account whose synced email is not verified.
            if (!account.emailVerified) {
                throw AppError.forbidden(
                    'Email address not verified',
                    AUTH_ERROR_CODES.EMAIL_UNVERIFIED,
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