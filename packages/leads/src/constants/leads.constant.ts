export const LEADS_MODULE = 'leads' as const;

export const LEADS_ERROR_CODES = {
    WAITLIST_ALREADY_SUBSCRIBED: 'LEADS_WAITLIST_ALREADY_SUBSCRIBED',
} as const;

/**
 * Privacy-policy revision in force. Stamped onto every insert's
 * consentVersion/consentTimestamp — see docs/leads-schema.md §2.1 and
 * docs/web-api-integration.md. Bump this (and only this) when the policy
 * text changes; it is intentionally a code constant, not a DB row, so a
 * policy change is a one-line PR with a clear diff/blame trail.
 */
export const CURRENT_CONSENT_VERSION = '2026-08-01';
