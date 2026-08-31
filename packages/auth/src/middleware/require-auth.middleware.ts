import type { Request, RequestHandler } from 'express';
import {createClerkClient, verifyToken } from '@clerk/backend';
import { AppError, env } from '@hitbox/shared';
import { AUTH_ERROR_CODES } from '../constants/auth.constant';
import { AccountStatus } from '../domain/enums/account-status.enum';
import type { IAccountLookup } from '../domain/interfaces/account-lookup.interface';
import type { AuthContext } from '../types/auth.types';

interface RequireAuthDeps {
    accounts: IAccountLookup;
    /** Asserted present by createAuthModule — env.CLERK_SECRET_KEY is optional at the shared-schema level. */
    clerkSecretKey: string;
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

    const clerk = createClerkClient({ secretKey: deps.clerkSecretKey });


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

            const account = await deps.accounts.findByClerkUserId(payload.sub);
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