export const AUDIT_MODULE = 'audit' as const;

export const AUDIT_ERROR_CODES = {
    /** record()/emit() was called with an eventType that is not registered. */
    UNKNOWN_EVENT_TYPE: 'AUDIT_UNKNOWN_EVENT_TYPE',
    /** An event arrived with no correlationId, so nothing can be joined to it. */
    MISSING_CORRELATION_ID: 'AUDIT_MISSING_CORRELATION_ID',
    /** The catalog row exists but has been retired (`isActive = false`). */
    INACTIVE_EVENT_TYPE: 'AUDIT_INACTIVE_EVENT_TYPE',
    /** A CRITICAL event could not be persisted, so its operation must fail. */
    WRITE_FAILED: 'AUDIT_WRITE_FAILED',
    /** An org-scoped reader asked for a different organization's trail. */
    CROSS_TENANT_READ: 'AUDIT_CROSS_TENANT_READ',
    /** The cursor in a paged read is not a cursor this API issued. */
    INVALID_CURSOR: 'AUDIT_INVALID_CURSOR',
    /** No retention policy row exists for a severity. */
    RETENTION_POLICY_MISSING: 'AUDIT_RETENTION_POLICY_MISSING',
} as const;

/**
 * Events this module publishes on the bus.
 *
 * Note what is absent: there is no per-record event. Alerting reads the table
 * (see docs/audit-logging.md §8) rather than subscribing to a mirror of every
 * write, which would double the platform's event volume and — because a record
 * can be written inside the caller's transaction — could announce a row that
 * then rolled back. These two are about the trail's own health.
 */
export const AUDIT_EVENTS = {
    /** A best-effort emit() was lost. Operational signal, not a trail entry. */
    WRITE_DROPPED: 'audit.write.dropped',
    /** A retention policy row changed, so the next prune sweep differs. */
    RETENTION_POLICY_CHANGED: 'audit.retention-policy.changed',
} as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

// ────────────────────────────────────────────────────────────────────────────
// Read API paging
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on a single page. The trail is the largest table in the
 * platform, so an unbounded `limit` is a self-service outage — and anyone
 * who genuinely needs the whole range should be going through an audited
 * `audit.export`, not a paging loop nobody can see.
 */
export const AUDIT_QUERY_MAX_LIMIT = 200;

export const AUDIT_QUERY_DEFAULT_LIMIT = 50;

// ────────────────────────────────────────────────────────────────────────────
// Capabilities this module's routes are guarded by
// ────────────────────────────────────────────────────────────────────────────

/**
 * Named here as plain strings rather than imported from @hitbox/access-control:
 * the guard is injected into `createAuditModule`, so this package depends on
 * the *capability names* and never on the authorization module's internals.
 */
export const AUDIT_CAPABILITIES = {
    /** Query the trail. Held at :global or :organization. */
    READ: 'audit-log:read',
    /** Pull the trail in bulk. The exfiltration path — :global only. */
    EXPORT: 'audit-log:export',
    /**
     * Change retention windows. Separate from EXPORT because they are
     * different powers: export copies evidence out, manage decides how long
     * evidence exists at all.
     */
    MANAGE: 'audit-log:manage',
} as const;
