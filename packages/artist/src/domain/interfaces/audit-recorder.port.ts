import type {
    AuditActionResult,
    AuditActorType,
    AuditSeverity,
    Prisma,
} from '@hitbox/database';

/**
 * The artist module's audit hook — the slice of the audit recorder it writes
 * through.
 *
 * Declared here rather than imported from `@hitbox/audit`: a consumer owns its
 * port, like orders' and payments' copies. The enums come from
 * `@hitbox/database`, so the shape matches `IAuditRecorder` and bootstrap
 * passes the real recorder straight in.
 *
 * What is audited: every change an artist makes to their collections — create,
 * edit, hero image, reorder, delete, restore. The event types are registered
 * in `@hitbox/audit`'s AUDIT_EVENT_CATALOG (`artist.collection.*`).
 */
export interface ArtistAuditRecordInput {
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

export interface IArtistAuditRecorder {
    record(
        input: ArtistAuditRecordInput,
        options?: { tx?: Prisma.TransactionClient },
    ): Promise<void>;
}

/** Discards everything. Unit tests only — never a running server. */
export const NOOP_ARTIST_AUDIT: IArtistAuditRecorder = {
    record: () => Promise.resolve(),
};
