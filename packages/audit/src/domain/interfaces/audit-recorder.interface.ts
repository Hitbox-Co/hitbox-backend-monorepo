import type { AuditActionResult, AuditActorType, AuditSeverity, Prisma } from '@hitbox/database';

/**
 * Who acted. Every field is an identifier copied by value — there is no
 * relation to User, Organization or any resource table, deliberately, so the
 * trail stays readable after the thing it describes is archived or deleted
 * (see the header of audit.prisma).
 */
export interface AuditActor {
    type: AuditActorType;
    /** Null for SYSTEM — a scheduled job or webhook has no human behind it. */
    id?: string | null;
    /**
     * The actor's roles at the moment of the action. A snapshot, not a lookup:
     * if this were resolved at read time, a later revocation would rewrite
     * history and the trail would say the action was unauthorised.
     */
    roleSnapshot?: string | null;
}

/** What was touched. `type` is a free string, `id` a uuid, neither a foreign key. */
export interface AuditResource {
    type?: string | null;
    id?: string | null;
}

/** Where the request came from. All optional — a job has none of it. */
export interface AuditRequestContext {
    ipAddress?: string | null;
    userAgent?: string | null;
    deviceId?: string | null;
}

export interface AuditRecordInput {
    /** A key registered in AuditEventType, e.g. 'role.assign'. */
    eventType: string;
    actor: AuditActor;
    result: AuditActionResult;
    /** Null when the action is not org-owned. */
    organizationId?: string | null;
    resource?: AuditResource;
    /** Pre-change snapshot. Omit for a create. */
    beforeState?: Prisma.InputJsonValue | null;
    /** Post-change snapshot. Omit for a delete or a denial. */
    afterState?: Prisma.InputJsonValue | null;
    /**
     * Stitches every event from one request together. Required: an event with
     * no correlation cannot be joined to the ledger write or the second-order
     * change it caused, which is most of the value of having the trail.
     */
    correlationId: string;
    /**
     * For a provenance-affecting action, the BlockchainLedger row it produced.
     * A FAILURE that still carries one means ownership state may be stale —
     * there is an alerting rule for exactly that.
     */
    ledgerReferenceId?: string | null;
    request?: AuditRequestContext;
    /** Anything else worth capturing. Defaults to `{}`, never null. */
    metadata?: Prisma.InputJsonValue;
    /**
     * Overrides the severity derived from the event type. Reach for this only
     * when one call site is genuinely more or less serious than the catalog
     * default — if it is always more serious, fix the catalog instead.
     */
    severity?: AuditSeverity;
    /**
     * When the action happened, if not now. Defaults to the write time; the
     * row's own `insertedAt` is always the write time, so a backdated event
     * is visible as one rather than hidden.
     */
    occurredAt?: Date;
}

/**
 * The port every other module writes the trail through.
 *
 * Two methods, and the difference between them is a policy decision, not a
 * convenience:
 *
 *   `record()` is awaited and throws. A CRITICAL action whose audit write
 *   failed is an action nobody can account for, so it must not be treated as
 *   having succeeded — a grant you cannot explain is a failed grant.
 *
 *   `emit()` is best-effort and never throws. Use it on hot paths, chiefly
 *   DENIED results, which are frequent, individually cheap, and valuable in
 *   aggregate. An audit outage must not become a request outage.
 *
 * Business modules depend on this interface, not on the service, so a module
 * can be tested with NOOP_AUDIT_RECORDER and extracted without dragging the
 * audit implementation along.
 */
export interface AuditRecordOptions {
    /**
     * Write through the caller's interactive transaction, so the change and
     * its record commit together. Strongly preferred for anything CRITICAL:
     * awaiting alone still allows a committed change whose audit row failed.
     *
     *     await prisma.$transaction(async (tx) => {
     *         const role = await roles.assign(input, tx);
     *         await audit.record({ eventType: 'role.assign', … }, { tx });
     *     });
     */
    tx?: Prisma.TransactionClient;
}

export interface IAuditRecorder {
    record(input: AuditRecordInput, options?: AuditRecordOptions): Promise<void>;
    emit(input: AuditRecordInput): void;
}

/**
 * Discards everything. For unit tests of other modules, and for local scripts
 * that must not write to the trail. Never wire this into a running server —
 * it would leave the platform silently unaudited, which looks identical to
 * "nothing happened".
 */
export const NOOP_AUDIT_RECORDER: IAuditRecorder = {
    record: () => Promise.resolve(),
    emit: () => undefined,
};
