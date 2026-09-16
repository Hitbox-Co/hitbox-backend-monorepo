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
 * `IMediaUrlResolver` is declared three times across the codebase: a consumer
 * owns its port. The enums come from `@hitbox/database`, which every module
 * already shares, so the shape matches `IAuditRecorder` and bootstrap passes
 * the real recorder straight in.
 *
 * Payments writes CRITICAL events almost exclusively — a refund approval, a
 * gateway credential change, a dispute resolution — so `record` (awaited,
 * throws, joins the caller's transaction) is the normal call here and `emit`
 * is the exception.
 */

export interface PaymentsAuditRecordInput {
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

export interface IPaymentsAuditRecorder {
    record(
        input: PaymentsAuditRecordInput,
        options?: { tx?: Prisma.TransactionClient },
    ): Promise<void>;
    emit(input: PaymentsAuditRecordInput): void;
}

/** Discards everything. Unit tests only — never a running server. */
export const NOOP_PAYMENTS_AUDIT: IPaymentsAuditRecorder = {
    record: () => Promise.resolve(),
    emit: () => undefined,
};
