import { z } from 'zod';

/**
 * Attribution fields (docs §2.6). None are read/sent anywhere in the site
 * today — verified by search — so every field here is optional. Once the
 * frontend adds hidden inputs for these (read from the query string on
 * landing, persisted for the session), they start flowing through
 * unchanged; no API contract change needed on this side.
 */
export const requestContextSchema = z.object({
    sourcePage: z.string().trim().max(255).optional(),
    utmSource: z.string().trim().max(255).optional(),
    utmMedium: z.string().trim().max(255).optional(),
    utmCampaign: z.string().trim().max(255).optional(),
    utmContent: z.string().trim().max(255).optional(),
    utmTerm: z.string().trim().max(255).optional(),
});

export type RequestContextDto = z.infer<typeof requestContextSchema>;

/** Values derived server-side (never trusted from the request body). */
export interface ServerContext {
    ipHash: string | null;
    userAgentSummary: string | null;
    consentVersion: string;
    consentTimestamp: Date;
    /** sourcePage from a hidden field is more reliable than Referer (docs §2.6), but Referer is the fallback when it's absent. */
    refererFallback: string | null;
}
