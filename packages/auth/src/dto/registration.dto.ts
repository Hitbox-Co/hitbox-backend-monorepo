import { z } from 'zod';

/**
 * Server-side registration input validation.
 *
 * Registration itself (account + password + email code) is handled by Clerk;
 * the backend never receives or stores passwords. This schema lets the client
 * pre-validate the fields HitBox cares about against the SAME rules the API
 * enforces everywhere, and returns the standard VALIDATION_ERROR envelope.
 */

/** Trimmed, lowercased, format-checked email. */
export const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(255)
    .email('Enter a valid email address');

/** 3–50 chars, letters/numbers/underscore/dot — mirrors users profile rules. */
export const usernameSchema = z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(50)
    .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, numbers, "_" and "." are allowed');

export const nameSchema = z.string().trim().max(100);

export const registrationValidationSchema = z
    .object({
        email: emailSchema,
        username: usernameSchema.optional(),
        firstName: nameSchema.optional(),
        lastName: nameSchema.optional(),
    })
    .strict();

export type RegistrationValidationDto = z.infer<typeof registrationValidationSchema>;
