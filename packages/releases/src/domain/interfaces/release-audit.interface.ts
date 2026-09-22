/**
 * Port: the compliance trail.
 *
 * Narrower than the audit module's own `IAuditRecorder` on purpose — this
 * module needs to *write* five event types and nothing else, so that is all it
 * declares. Bootstrap adapts the real recorder onto it.
 *
 * Every release action goes through `record`, which is awaited and may throw:
 * an approval whose audit write failed is an approval nobody can account for,
 * and treating it as successful is how a trail quietly develops holes.
 */
export interface IReleaseAudit {
    record(input: ReleaseAuditInput): Promise<void>;
}

export interface ReleaseAuditInput {
    /** `release.submit` | `release.approve` | `release.reject` | `release.amend` | `release.reopen` */
    eventType: string;
    actorId: string;
    /** Which hat the actor was wearing on this drop — see `auditActorType`. */
    actorType: 'ARTIST' | 'BRAND_EMPLOYEE' | 'HITBOX_ADMIN';
    /** The drop's owner, so the trail can be filtered by brand. */
    organizationId: string | null;
    approvalId: string;
    productId: string;
    /** `SUCCESS` for an action taken, `DENIED` for one refused by the rules. */
    result: 'SUCCESS' | 'DENIED';
    /**
     * Stitches this record to every other event from the same request. Taken
     * from the request rather than generated here — an event that cannot be
     * joined to the change it describes is most of the trail's value lost.
     */
    correlationId: string;
    /** Snapshot before the change. Omit for a create. */
    before?: Record<string, unknown> | undefined;
    after?: Record<string, unknown> | undefined;
    /** Anything worth keeping that is not a state diff — the reason, the rule. */
    metadata?: Record<string, unknown> | undefined;
}

/** Discards everything. For unit tests only — never wire it into a server. */
export const NOOP_RELEASE_AUDIT: IReleaseAudit = {
    record: () => Promise.resolve(),
};
