import type { Request, RequestHandler } from 'express';
import { AppError } from '@hitbox/shared';
import { AUTHZ_ERROR_CODES } from '../constants/authz.constant';

/**
 * STEP-UP (RE-VERIFICATION) GATE
 * ==============================
 * Holding a dangerous permission is not the same as having proved, recently,
 * that you are still the person who holds it. A stolen session token is enough
 * to use a permission; it is not enough to re-authenticate.
 *
 * We read Clerk's `fva` ("factor verification age") session claim, which is
 * exactly what it is designed for:
 *
 *   fva = [ minutes since the FIRST factor was verified,
 *           minutes since the SECOND factor was verified ]
 *
 *   -1 in a slot means "not applicable" (e.g. no MFA on the account).
 *
 * `iat` is deliberately NOT used: Clerk session tokens are short-lived and
 * silently refreshed, so `iat` is always seconds old and would make every
 * request look freshly authenticated.
 *
 * Fail closed: if the claim is absent (old token version, misconfigured JWT
 * template) the request is refused with STEP_UP_REQUIRED rather than allowed.
 * The client is expected to run Clerk's re-verification flow and retry.
 */

/** Throws unless the session proved a factor within `maxAgeMinutes`. */
export function assertStepUpSatisfied(req: Request, maxAgeMinutes: number): void {
    const factorAge = req.auth?.factorVerificationAge ?? null;

    if (!factorAge) {
        throw new AppError(
            'This operation requires re-verifying your identity',
            403,
            AUTHZ_ERROR_CODES.STEP_UP_REQUIRED,
            { maxAgeMinutes, reason: 'session token carries no factor verification age' },
        );
    }

    const [firstFactorAge, secondFactorAge] = factorAge;

    // Either factor verified recently enough satisfies the gate; a second
    // factor verified just now is at least as strong as a first factor.
    const freshest = [firstFactorAge, secondFactorAge]
        .filter((age) => typeof age === 'number' && age >= 0)
        .sort((a, b) => a - b)[0];

    if (freshest === undefined || freshest > maxAgeMinutes) {
        throw new AppError(
            'This operation requires re-verifying your identity',
            403,
            AUTHZ_ERROR_CODES.STEP_UP_REQUIRED,
            { maxAgeMinutes, factorVerificationAge: factorAge },
        );
    }
}

/**
 * Standalone guard, for routes that need step-up regardless of whether the
 * permission they use is marked sensitive (e.g. an account-closure endpoint).
 * Sensitive catalog permissions are gated automatically by requirePermission.
 */
export function requireStepUp(maxAgeMinutes: number): RequestHandler {
    return (req, _res, next) => {
        try {
            assertStepUpSatisfied(req, maxAgeMinutes);
            next();
        } catch (error) {
            next(error);
        }
    };
}
