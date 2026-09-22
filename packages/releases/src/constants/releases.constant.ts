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
    /** The caller is not the party entitled to decide this drop. */
    NOT_THE_APPROVER: 'RELEASES_NOT_THE_APPROVER',
    /** Approving without accepting the legal compliance terms. */
    LEGAL_ACCEPTANCE_REQUIRED: 'RELEASES_LEGAL_ACCEPTANCE_REQUIRED',
    /** Reopening a review that was never decided, or is already open. */
    NOT_REOPENABLE: 'RELEASES_NOT_REOPENABLE',
} as const;

/**
 * The wording an approver accepts, versioned.
 *
 * Stored on every approval so the trail records *which* terms were accepted,
 * not merely that a box was ticked. Bump this when the wording changes; old
 * approvals keep pointing at the version they actually agreed to.
 */
export const LEGAL_COMPLIANCE_VERSION = '2026-09-v1' as const;

export const LEGAL_COMPLIANCE_STATEMENT =
    'I confirm this drop complies with all applicable laws and platform policies, ' +
    'that the rights to every asset in it are held or licensed, that age and odds ' +
    'disclosures are accurate, and that I am authorised to give this confirmation ' +
    'on behalf of its owner.';

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
    REOPENED: 'releases.approval.reopened',
} as const;

/** Audit event types this module records. Registered in the audit catalog. */
export const RELEASE_AUDIT_EVENTS = {
    SUBMIT: 'release.submit',
    APPROVE: 'release.approve',
    REJECT: 'release.reject',
    AMEND: 'release.amend',
    REOPEN: 'release.reopen',
} as const;
