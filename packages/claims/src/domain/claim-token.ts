import { createHash, randomBytes } from 'node:crypto';

/**
 * The one-shot token that ties a confirm to the validate that preceded it.
 *
 * Without it, `POST /claims/:tagId/confirm` is a request anyone who captured
 * it can send again. That is harmless only while the item stays claimed — and
 * it does not: `revokeClaim()` puts a refunded unit back to UNCLAIMED, at
 * which point the captured request works, and the refunded buyer owns the
 * item again.
 */

/**
 * How long a token stays usable. Two minutes is the gap between a tap and a
 * thumb hitting "claim"; it is deliberately not generous, because the window
 * is also how long a captured request stays replayable. A client that takes
 * longer re-validates, which costs one round trip.
 */
export const CLAIM_TOKEN_TTL_SECONDS = 120;

/**
 * 32 bytes of CSPRNG entropy, base64url so it survives a JSON body and a
 * query string unescaped. Not a UUID: a token is a secret, and UUIDv7 leaks
 * its issue time and is not generated to be unguessable.
 */
export function generateClaimToken(): string {
    return randomBytes(32).toString('base64url');
}

/**
 * What actually gets stored. The raw token exists in the validate response and
 * the confirm request and nowhere else — never in a log line, never in an
 * error body, never at rest. A stolen database backup must not be a list of
 * working claim authorisations.
 *
 * Plain SHA-256 rather than a password hash: the input is 256 bits of
 * uniform randomness, so there is nothing to brute-force and nothing for a
 * slow KDF to protect. What matters here is that the lookup stays a single
 * indexed equality check inside the claim transaction.
 */
export function hashClaimToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Why a presented token was refused. */
export type ClaimTokenRejectionReason = 'INVALID' | 'REUSED' | 'EXPIRED';

/**
 * Thrown from inside the claim transaction so the whole thing rolls back.
 *
 * That rollback is the point: the token check runs before the SKU is touched,
 * so a replayed request cannot change anything on its way to being refused.
 */
export class ClaimTokenRejectedError extends Error {
    constructor(
        readonly reason: ClaimTokenRejectionReason,
        /** The offending row, when there was one. Null for a token we have never seen. */
        readonly tokenId: string | null = null,
        /** Detail for the log line only — never returned to the caller. */
        readonly detail?: string,
    ) {
        super(`Claim token rejected: ${reason}`);
        this.name = 'ClaimTokenRejectedError';
        Error.captureStackTrace(this, this.constructor);
    }
}

export function isClaimTokenRejected(error: unknown): error is ClaimTokenRejectedError {
    return error instanceof ClaimTokenRejectedError;
}

/** Expiry for a token issued at `now`. */
export function claimTokenExpiry(now: Date): Date {
    return new Date(now.getTime() + CLAIM_TOKEN_TTL_SECONDS * 1_000);
}
