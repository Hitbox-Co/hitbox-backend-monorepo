import cors from 'cors';
import type { RequestHandler } from 'express';
import { ORGANIZATION_HEADER, CLIENT_SURFACE_HEADER } from '@hitbox/authz';
import { createModuleLogger, isProduction } from '@hitbox/shared';

const logger = createModuleLogger('cors');

/**
 * Per-surface CORS.
 *
 * Why not one global `origin: '*'`: the admin console and the customer site are
 * different trust boundaries. Allowing every origin to talk to
 * /api/v1/admin/* means any page a logged-in operator visits can attempt
 * administrative calls with their cookie. Narrowing the admin surface to
 * admin.hitbox.com removes that class of attack entirely.
 *
 * `allowed === null` (no allowlist configured) preserves the previous
 * behaviour of accepting any origin, so nothing breaks before the environment
 * is configured — but it is logged once in production, because shipping
 * without an admin allowlist is a real finding, not a preference.
 */
export function surfaceCors(surface: string, allowed: string[] | null): RequestHandler {
    if (allowed === null) {
        if (isProduction) {
            logger.warn(
                { surface },
                'no CORS allowlist configured for this surface — every browser origin is accepted',
            );
        }
        return cors({
            origin: '*',
            allowedHeaders: defaultAllowedHeaders,
            exposedHeaders: ['x-request-id'],
        });
    }

    return cors({
        // Requests with no Origin (mobile apps, server-to-server, curl) are
        // allowed through: CORS is a browser control, and blocking them here
        // would break the mobile client while stopping no attacker.
        origin: (origin, callback) => {
            if (!origin || allowed.includes(origin)) return callback(null, true);
            logger.warn({ surface, origin }, 'CORS origin rejected');
            return callback(null, false);
        },
        // The admin/manage consoles authenticate with Clerk's __session cookie.
        credentials: true,
        allowedHeaders: defaultAllowedHeaders,
        exposedHeaders: ['x-request-id'],
        maxAge: 600,
    });
}

const defaultAllowedHeaders = [
    'content-type',
    'authorization',
    'x-request-id',
    ORGANIZATION_HEADER,
    CLIENT_SURFACE_HEADER,
];
