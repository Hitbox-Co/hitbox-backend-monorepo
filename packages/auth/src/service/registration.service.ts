import { AppError } from '@hitbox/shared';
import { AUTH_ERROR_CODES } from '../constants/auth.constant';
import type { IAccountLookup } from '../domain/interfaces/account-lookup.interface';
import type { RegistrationValidationDto } from '../dto/registration.dto';

interface RegistrationServiceDeps {
    accounts: IAccountLookup;
}

export interface RegistrationValidationResult {
    valid: true;
    email: string;
}

/**
 * Validates registration input (format done by Zod in the controller) and
 * enforces the one rule that needs the database: email uniqueness. Creates
 * nothing — Clerk owns account creation.
 */
export class RegistrationService {
    constructor(private readonly deps: RegistrationServiceDeps) { }

    async validate(input: RegistrationValidationDto): Promise<RegistrationValidationResult> {
        if (await this.deps.accounts.emailExists(input.email)) {
            throw AppError.conflict(
                'An account with this email already exists',
                AUTH_ERROR_CODES.EMAIL_TAKEN,
            );
        }
        return { valid: true, email: input.email };
    }
}
