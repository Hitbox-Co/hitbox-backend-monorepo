import { AppError } from '@hitbox/shared';
import { PAYMENTS_ERROR_CODES } from '../constants/payments.constant';

/**
 * What a gateway adapter throws when the provider did not do what was asked.
 *
 *   NOT_CONFIGURED  no key behind the configuration's `credentialsRef`
 *   REJECTED        the provider answered and said no — retrying the same
 *                   request will get the same answer
 *   UNREACHABLE     network failure or a provider-side 5xx — safe to retry,
 *                   because every request carries an idempotency key
 *
 * Provider-neutral on purpose: services map this to an `AppError` without
 * knowing which SDK, or which HTTP shape, produced it.
 */
export type GatewayErrorKind = 'NOT_CONFIGURED' | 'REJECTED' | 'UNREACHABLE';

export class GatewayError extends Error {
    constructor(
        readonly kind: GatewayErrorKind,
        message: string,
        readonly details: { providerCode?: string | null; requestId?: string | null } = {},
    ) {
        super(message);
        this.name = 'GatewayError';
    }
}

/**
 * Turns a gateway failure into the error the caller sees.
 *
 * All three are 4xx on purpose: a 5xx is masked as a generic 500, and the
 * operator pressing the button needs to read *why* — "this charge was already
 * refunded" is something they can act on. Anything that is not a
 * `GatewayError` is a bug and is rethrown untouched.
 */
export function gatewayFailure(error: unknown, action: string): never {
    if (!(error instanceof GatewayError)) throw error;
    const details = {
        providerCode: error.details.providerCode ?? null,
        providerRequestId: error.details.requestId ?? null,
    };
    switch (error.kind) {
        case 'NOT_CONFIGURED':
            throw AppError.badRequest(
                `Cannot ${action}: ${error.message}`,
                PAYMENTS_ERROR_CODES.GATEWAY_UNAVAILABLE,
                details,
            );
        case 'REJECTED':
            throw AppError.badRequest(
                `The payment provider refused to ${action}: ${error.message}`,
                PAYMENTS_ERROR_CODES.GATEWAY_REJECTED,
                details,
            );
        case 'UNREACHABLE':
            throw AppError.badRequest(
                `The payment provider could not be reached to ${action}. Nothing was changed here — try again.`,
                PAYMENTS_ERROR_CODES.GATEWAY_UNREACHABLE,
                details,
            );
    }
}
