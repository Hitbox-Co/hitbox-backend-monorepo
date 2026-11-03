import type {
    AuditActionResult,
    AuditActorType,
    AuditSeverity,
    Prisma,
} from '@hitbox/database';

/**
 * The content module's audit hook — the slice of the audit recorder it writes
 * through. Declared here rather than imported from `@hitbox/audit`: a
 * consumer owns its port, like the artist, orders and payments copies. The
 * shape matches `IAuditRecorder`, so bootstrap passes the real recorder in.
 *
 * What is audited here: HitBox staff moderating a reward — switch off / on,
 * remove / restore (`content.reward.*`). An artist's own reward changes are
 * audited by the artist module (`artist.collection.reward.*`).
 */
export interface ContentAuditRecordInput {
    eventType: string;
    actor: { type: AuditActorType; id?: string | null; roleSnapshot?: string | null };
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

export interface IContentAuditRecorder {
    record(input: ContentAuditRecordInput, options?: { tx?: Prisma.TransactionClient }): Promise<void>;
}
