export const RELEASES_MODULE = 'releases' as const;

export const RELEASES_ERROR_CODES = {
    NOT_FOUND: 'RELEASES_NOT_FOUND',
    /** A decision was already recorded on this approval. */
    ALREADY_DECIDED: 'RELEASES_ALREADY_DECIDED',
    /** Rejecting without saying why. */
    COMMENT_REQUIRED: 'RELEASES_COMMENT_REQUIRED',
    /** An age-restricted or randomised drop missing its compliance evidence. */
    COMPLIANCE_INCOMPLETE: 'RELEASES_COMPLIANCE_INCOMPLETE',
    /** The product already has an open approval at this version. */
    ALREADY_PENDING: 'RELEASES_ALREADY_PENDING',
} as const;

export const RELEASE_READ_CAPABILITY = 'release-approval:read' as const;
/** Recording a decision — approve, reject, or amend the compliance sign-off. */
export const RELEASE_DECIDE_CAPABILITY = 'release-approval:manage' as const;
/**
 * Reversing a decision that has already been recorded. Held only at `:global`
 * by HITBOX_SYSTEM_ADMIN, which is what keeps "I changed my mind" separate
 * from "I am overruling a compliance officer".
 */
export const RELEASE_OVERRIDE_CAPABILITY = 'release-approval:override' as const;

export const RELEASES_DEFAULT_LIMIT = 20;
export const RELEASES_MAX_LIMIT = 100;

export const RELEASE_EVENTS = {
    SUBMITTED: 'releases.approval.submitted',
    DECIDED: 'releases.approval.decided',
} as const;
