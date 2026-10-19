import type {
    AuditActionResult,
    AuditActorType,
    AuditSeverity,
    Prisma,
} from '@hitbox/database';

/**
 * The slice of the audit recorder this module writes through.
 *
 * Declared here rather than imported from `@hitbox/audit` on purpose. The
 * design document's `financial_audit_log` requirement is satisfied by the
 * platform's existing append-only audit trail, and finance is one of its
 * writers — but a *writer* should not take a package dependency on the log to
 * write to it, any more than auth depends on users to look up an account. The
 * enums come from `@hitbox/database`, which both modules already share, so the
 * shape matches `IAuditRecorder` exactly and bootstrap can pass the real
 * recorder straight in.
 *
 * `record` is awaited and throws — a royalty posting nobody can account for is
 * a posting that must not be treated as having happened. `emit` is
 * best-effort, for read-path and denial events where an audit outage must not
 * become a request outage.
 */

export interface FinanceAuditRecordInput {
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

export interface IFinanceAuditRecorder {
    record(
        input: FinanceAuditRecordInput,
        options?: { tx?: Prisma.TransactionClient },
    ): Promise<void>;
    emit(input: FinanceAuditRecordInput): void;
}

/**
 * Discards everything. For unit tests only — wiring this into a running server
 * would leave every money movement unaudited, which reads identically to
 * "no money moved".
 */
export const NOOP_FINANCE_AUDIT: IFinanceAuditRecorder = {
    record: () => Promise.resolve(),
    emit: () => undefined,
};
