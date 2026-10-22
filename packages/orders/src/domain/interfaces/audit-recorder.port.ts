import type {
    AuditActionResult,
    AuditActorType,
    AuditSeverity,
    Prisma,
} from '@hitbox/database';

/**
 * The slice of the audit recorder this module writes through.
 *
 * Declared here rather than imported from `@hitbox/audit` — a consumer owns
 * its port, the same as payments' copy. The enums come from
 * `@hitbox/database`, so the shape matches `IAuditRecorder` and bootstrap
 * passes the real recorder straight in.
 *
 * Orders audits what **people** do to an order (change its status, record or
 * correct its tracking). What the system does — a webhook settling it, the
 * sweep cancelling it, an NFC tap delivering it — is on the order's own
 * status history, which every change writes.
 */
export interface OrdersAuditRecordInput {
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
    metadata?: Prisma.InputJsonValue;
    severity?: AuditSeverity;
    occurredAt?: Date;
}

export interface IOrdersAuditRecorder {
    record(
        input: OrdersAuditRecordInput,
        options?: { tx?: Prisma.TransactionClient },
    ): Promise<void>;
}

/** Discards everything. Unit tests only — never a running server. */
export const NOOP_ORDERS_AUDIT: IOrdersAuditRecorder = {
    record: () => Promise.resolve(),
};
