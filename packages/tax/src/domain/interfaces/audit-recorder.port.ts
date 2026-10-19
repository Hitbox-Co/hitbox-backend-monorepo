import { randomUUID } from 'node:crypto';
import type {
    AuditActionResult,
    AuditActorType,
    AuditSeverity,
    Prisma,
} from '@hitbox/database';

/**
 * The slice of the audit recorder this module writes through.
 *
 * Declared here rather than imported from `@hitbox/audit`, for the same reason
 * finance declares its own: a *writer* should not take a package dependency on
 * the log it writes to. The enums come from `@hitbox/database`, which both
 * modules already share, so the shape matches `IAuditRecorder` exactly and
 * bootstrap passes the real recorder straight in.
 *
 * Every write in this module is audited, and so is every **read of a
 * document**. Downloading an invoice or a W-9 is a disclosure of personal
 * data — a customer's address, a taxpayer identification number — and "who
 * looked at this, and when" is a question both a tax audit and a data-subject
 * request will ask. That is why `TAX_AUDIT_EVENTS` carries `INVOICE_DOWNLOAD`
 * and `ARTIST_DOCUMENT_DOWNLOAD` beside the write events.
 */

export interface TaxAuditRecordInput {
    eventType: string;
    actor: {
        type: AuditActorType;
        id?: string | null;
        roleSnapshot?: string | null;
    };
    result: AuditActionResult;
    organizationId?: string | null;
    resource?: { type?: string | null; id?: string | null };
    beforeState?: Prisma.InputJsonValue | null;
    afterState?: Prisma.InputJsonValue | null;
    correlationId: string;
    ledgerReferenceId?: string | null;
    metadata?: Prisma.InputJsonValue;
    severity?: AuditSeverity;
    occurredAt?: Date;
}

export interface ITaxAuditRecorder {
    record(
        input: TaxAuditRecordInput,
        options?: { tx?: Prisma.TransactionClient },
    ): Promise<void>;
    emit(input: TaxAuditRecordInput): void;
}

/**
 * Discards everything. For unit tests only — wiring this into a running server
 * would leave every invoice unaudited, which in a tax audit reads identically
 * to "no invoice was issued".
 */
export const NOOP_TAX_AUDIT: ITaxAuditRecorder = {
    record: () => Promise.resolve(),
    emit: () => undefined,
};

/**
 * The shape this module's services actually think in, and the adapter that
 * widens it to the recorder's.
 *
 * Services say "this actor did this to this record"; the trail also wants an
 * actor type, a result and a correlation id. Defaulting them in one place
 * keeps thirty call sites from repeating the same four fields — and keeps the
 * defaults honest: an unattributed write is `SYSTEM`, because the invoice
 * issued by the settlement subscriber genuinely has no human behind it.
 */
export interface TaxAuditEvent {
    eventType: string;
    /** Null for the settlement subscriber — nobody clicked anything. */
    actorId: string | null;
    /** e.g. 'Invoice', 'ArtistTaxDocument'. */
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    /** Defaults to SUCCESS; set FAILURE for a refused or failed action. */
    result?: AuditActionResult;
    severity?: AuditSeverity;
    correlationId?: string;
}

export async function recordTaxAudit(
    recorder: ITaxAuditRecorder,
    event: TaxAuditEvent,
): Promise<void> {
    await recorder.record({
        eventType: event.eventType,
        actor: event.actorId
            ? { type: 'HITBOX_EMPLOYEE' as AuditActorType, id: event.actorId }
            : { type: 'SYSTEM' as AuditActorType, id: null },
        result: event.result ?? ('SUCCESS' as AuditActionResult),
        resource: { type: event.targetType, id: event.targetId },
        // A correlation id ties the rows of one request together. Services are
        // not request-aware, so one is minted per event unless the caller
        // supplies the request's own.
        correlationId: event.correlationId ?? randomUUID(),
        ...(event.metadata ? { metadata: event.metadata as Prisma.InputJsonValue } : {}),
        ...(event.severity ? { severity: event.severity } : {}),
    });
}
