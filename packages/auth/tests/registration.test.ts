import { AppError } from '@hitbox/shared';
import { registrationValidationSchema } from '../src/dto/registration.dto';
import { RegistrationService } from '../src/service/registration.service';
import type { IAccountLookup } from '../src/domain/interfaces/account-lookup.interface';

describe('registrationValidationSchema (Zod)', () => {
    it('accepts a valid email and normalises case/whitespace', () => {
        const result = registrationValidationSchema.safeParse({ email: '  Buyer@Example.COM ' });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.email).toBe('buyer@example.com');
    });

    it.each(['abc@', 'a b@c.com', '', 'plainaddress', '@no-local.com'])(
        'rejects invalid email %j',
        (email) => {
            expect(registrationValidationSchema.safeParse({ email }).success).toBe(false);
        },
    );

    it('rejects a too-short or illegal username', () => {
        expect(registrationValidationSchema.safeParse({ email: 'a@b.com', username: 'ab' }).success).toBe(false);
        expect(registrationValidationSchema.safeParse({ email: 'a@b.com', username: 'a b' }).success).toBe(false);
    });

    it('accepts a valid username and names', () => {
        expect(
            registrationValidationSchema.safeParse({
                email: 'a@b.com',
                username: 'liam_collects.01',
                firstName: 'Liam',
                lastName: 'Carter',
            }).success,
        ).toBe(true);
    });

    it('rejects unknown fields (strict) — e.g. a password is never accepted here', () => {
        expect(
            registrationValidationSchema.safeParse({ email: 'a@b.com', password: 'x' }).success,
        ).toBe(false);
    });
});

describe('RegistrationService.validate', () => {
    const makeAccounts = (exists: boolean): IAccountLookup => ({
        findByClerkUserId: jest.fn(),
        emailExists: jest.fn().mockResolvedValue(exists),
    });

    it('passes when the email is not yet registered', async () => {
        const service = new RegistrationService({ accounts: makeAccounts(false) });
        await expect(service.validate({ email: 'new@example.com' })).resolves.toEqual({
            valid: true,
            email: 'new@example.com',
        });
    });

    it('throws a 409 AUTH_EMAIL_TAKEN when the email already exists', async () => {
        const service = new RegistrationService({ accounts: makeAccounts(true) });
        await expect(service.validate({ email: 'taken@example.com' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'AUTH_EMAIL_TAKEN',
        });
        await expect(service.validate({ email: 'taken@example.com' })).rejects.toBeInstanceOf(AppError);
    });
});
