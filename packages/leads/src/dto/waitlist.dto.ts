import { z } from 'zod';
import { requestContextSchema } from './common.dto';

/**
 * Matches WaitlistForm's three variants (footer / compact / full page) — see
 * docs/leads-schema.md §2.4. Only email is truly required; firstName is
 * required BY THE FORM but kept optional here as a safety net (a nullable
 * DB column, per the doc, should not throw on a client-side bug).
 *
 * `interests` accepts all three shapes formData.getAll() can produce (see
 * docs §2.3, "the interests trap") — normalized in the service layer.
 */
export const waitlistSubmitSchema = requestContextSchema.extend({
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    /** Full-page variant only — footer/compact never send this (§2.4). */
    country: z.string().trim().min(1).max(100).optional(),
    stateRegion: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    ageRange: z.string().trim().max(20).optional(),
    interests: z.union([z.array(z.string()), z.string()]).optional(),
    musicGenres: z.union([z.array(z.string()), z.string()]).optional(),
    referralSource: z.string().trim().max(100).optional(),
    /** Currently just the literal "yes" — no dedicated consent column exists; kept for the audit trail via rawPayload. */
    consent: z.string().optional(),
});

export type WaitlistSubmitDto = z.infer<typeof waitlistSubmitSchema>;
