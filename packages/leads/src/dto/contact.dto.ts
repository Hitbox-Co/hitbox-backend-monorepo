import { z } from 'zod';
import { requestContextSchema } from './common.dto';

/**
 * Matches ContactForm. `subject` is the form's field name for what the
 * schema calls `topic` — mapped in the service layer, not here (docs §3).
 * There is no consent checkbox on this form (docs §2.1) — consentVersion is
 * stamped server-side regardless, recording policy-in-force rather than an
 * affirmative tick.
 */
export const contactSubmitSchema = requestContextSchema.extend({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().email(),
    company: z.string().trim().max(255).optional(),
    phone: z.string().trim().max(50).optional(),
    subject: z.string().trim().min(1).max(255),
    message: z.string().trim().min(1),
});

export type ContactSubmitDto = z.infer<typeof contactSubmitSchema>;
