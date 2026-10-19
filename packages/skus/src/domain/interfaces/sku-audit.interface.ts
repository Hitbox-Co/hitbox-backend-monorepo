/**
 * Port: the compliance trail for edits to a serialized unit.
 *
 * Narrower than the audit module's own `IAuditRecorder` — this module writes
 * two event types and reads nothing — so that is all it declares. Bootstrap
 * adapts the real recorder onto it. Structural by design: nothing here imports
 * `@hitbox/audit`, and `@hitbox/audit` knows nothing about SKUs.
 *
 * `record` is **awaited and may throw**, and the service does not swallow it.
 * The edits that come through here are the ones a fraud review goes looking
 * for — a tag marked REVOKED, a unit's resale blocked, an item archived — and
 * a state change nobody can account for is worse than a failed request.
 */
export interface ISkuAudit {
    record(input: SkuAuditInput): Promise<void>;
}

export interface SkuAuditInput {
    /** `sku.update` | `sku.batch-update` — see SKU_AUDIT_EVENTS. */
    eventType: string;
    actorId: string;
    /**
     * The organization owning the drop this unit belongs to, so the trail can
     * be filtered by brand. Null for a platform-owned drop.
     */
    organizationId: string | null;
    /** The unit, or null for a batch — a batch names its members in metadata. */
    skuId: string | null;
    result: 'SUCCESS' | 'DENIED';
    /**
     * Stitches this record to every other event from the same request. Taken
     * from the request rather than generated here: an event that cannot be
     * joined to the change it describes is most of the trail's value lost.
     */
    correlationId: string;
    /** Only the fields that changed, before and after. Never the whole row. */
    before?: Record<string, unknown> | undefined;
    after?: Record<string, unknown> | undefined;
    /** The reason, the rule that refused, the batch's counts. */
    metadata?: Record<string, unknown> | undefined;
}

/** Discards everything. For unit tests only — never wire it into a server. */
export const NOOP_SKU_AUDIT: ISkuAudit = {
    record: () => Promise.resolve(),
};
