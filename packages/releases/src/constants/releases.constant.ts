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

/**
 * The comment written on a review that passed because nobody owned the drop.
 *
 * Fixed wording rather than free text so the case is greppable in the trail and
 * a screen can recognise it without parsing prose.
 */
export const AUTO_APPROVAL_COMMENT =
    'Auto-approved: this drop names no artist and no organization, so there is ' +
    'no owner whose approval the review exists to capture.';

export const RELEASE_READ_CAPABILITY = 'release-approval:read' as const;
/** Administering the queue — amending a reviewer's notes on an open review. */
export const RELEASE_DECIDE_CAPABILITY = 'release-approval:manage' as const;

/**
 * Sending a drop for review.
 *
 * `drop:manage`, NOT a release capability, and the distinction is the point:
 * submitting is something you do to **your own drop**, so whoever may edit the
 * drop may submit it. `HITBOX_DROP_MANAGER` holds `drop:manage:global` and only
 * `release-approval:read:global` — gating submit on a release capability locked
 * the role out of sending its own drops for review.
 */
export const RELEASE_SUBMIT_CAPABILITY = 'drop:manage' as const;

/**
 * Recording a decision. Any ONE of these reaches the endpoint.
 *
 * Three capabilities for one route because three genuinely different powers
 * arrive at it, and no single one of them is held by everybody entitled to
 * call it:
 *
 *   `approve` — the owner signing their own drop off (ARTIST, BRAND_ADMIN)
 *   `reject`  — the same owner refusing it
 *   `manage`  — whoever administers the queue (HITBOX_SYSTEM_ADMIN)
 *
 * Reaching the endpoint is not the same as being allowed to decide: which
 * party may approve *this* drop is resolved against the loaded row in
 * domain/approval-authority.ts, and an administrator holding `manage` still
 * cannot approve a brand's drop.
 */
export const RELEASE_DECISION_CAPABILITIES = [
    'release-approval:approve',
    'release-approval:reject',
    'release-approval:manage',
] as const;
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
