import { Prisma } from '@hitbox/database';
import type {
    AuditActionResult,
    AuditActorType,
    AuditEvent,
    AuditSeverity,
    PrismaClient,
} from '@hitbox/database';

/** One row, already resolved — the service does the deciding, this writes. */
export interface AuditEventRow {
    eventId: string;
    occurredAt: Date;
    eventType: string;
    actorType: AuditActorType;
    actorId: string | null;
    actorRoleSnapshot: string | null;
    organizationId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    actionResult: AuditActionResult;
    severity: AuditSeverity;
    beforeState: Prisma.InputJsonValue | null;
    afterState: Prisma.InputJsonValue | null;
    ipAddress: string | null;
    userAgent: string | null;
    deviceId: string | null;
    correlationId: string;
    ledgerReferenceId: string | null;
    metadata: Prisma.InputJsonValue;
    insertedAt: Date;
}

export interface AuditEventFilter {
    eventType?: string;
    actorId?: string;
    organizationId?: string;
    resourceType?: string;
    resourceId?: string;
    actionResult?: AuditActionResult;
    severity?: AuditSeverity;
    correlationId?: string;
    /** Inclusive lower bound on occurredAt. */
    from?: Date;
    /** Exclusive upper bound on occurredAt, so adjacent pages cannot overlap. */
    to?: Date;
}

/** Keyset position: the last row of the previous page. */
export interface AuditEventCursor {
    occurredAt: Date;
    eventId: string;
}

export interface AuditEventPage {
    events: AuditEvent[];
    /** Position to resume from, or null when the last page was returned. */
    nextCursor: AuditEventCursor | null;
}

/**
 * Reads and appends audit rows. Append-only by contract: there is no update
 * and no delete here, and the application's database credentials should not
 * hold those grants on this table either (see docs/audit-logging.md §7 —
 * nothing in the schema itself prevents an UPDATE). Pruning is a scheduled job
 * outside the application that drops whole partitions.
 */
export class AuditEventRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Appends one event. `beforeState`/`afterState` are nullable Json columns,
     * so an absent snapshot is written as a SQL NULL (`Prisma.DbNull`) rather
     * than the JSON value `null` — the two are distinguishable in Postgres and
     * conflating them would make "no snapshot taken" indistinguishable from
     * "the snapshot was literally null".
     *
     * `tx` writes through a caller's interactive transaction, so an audited
     * change and its record commit or roll back together. Without it, a
     * committed change whose audit row failed is exactly the unaccountable
     * state `record()` promises not to leave behind.
     */
    async append(row: AuditEventRow, tx?: Prisma.TransactionClient): Promise<void> {
        await (tx ?? this.prisma).auditEvent.create({
            data: {
                eventId: row.eventId,
                occurredAt: row.occurredAt,
                eventType: row.eventType,
                actorType: row.actorType,
                actorId: row.actorId,
                actorRoleSnapshot: row.actorRoleSnapshot,
                organizationId: row.organizationId,
                resourceType: row.resourceType,
                resourceId: row.resourceId,
                actionResult: row.actionResult,
                severity: row.severity,
                beforeState: row.beforeState ?? Prisma.DbNull,
                afterState: row.afterState ?? Prisma.DbNull,
                ipAddress: row.ipAddress,
                userAgent: row.userAgent,
                deviceId: row.deviceId,
                correlationId: row.correlationId,
                ledgerReferenceId: row.ledgerReferenceId,
                metadata: row.metadata,
                insertedAt: row.insertedAt,
            },
        });
    }

    /**
     * One page, newest first, by keyset rather than OFFSET.
     *
     * OFFSET on this table degrades linearly and — worse for an audit trail —
     * shifts under concurrent appends, so a reviewer paging backwards through
     * a live incident would skip rows. The keyset is (occurredAt, eventId),
     * which is exactly the primary key's ordering, so the page boundary is
     * stable no matter what is being written at the same time.
     */
    async findPage(
        filter: AuditEventFilter,
        limit: number,
        cursor?: AuditEventCursor,
    ): Promise<AuditEventPage> {
        const where: Prisma.AuditEventWhereInput = {
            ...(filter.eventType ? { eventType: filter.eventType } : {}),
            ...(filter.actorId ? { actorId: filter.actorId } : {}),
            ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
            ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
            ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
            ...(filter.actionResult ? { actionResult: filter.actionResult } : {}),
            ...(filter.severity ? { severity: filter.severity } : {}),
            ...(filter.correlationId ? { correlationId: filter.correlationId } : {}),
            ...(filter.from || filter.to
                ? {
                    occurredAt: {
                        ...(filter.from ? { gte: filter.from } : {}),
                        ...(filter.to ? { lt: filter.to } : {}),
                    },
                }
                : {}),
        };

        // Written out rather than handed to Prisma's `cursor`, because the
        // comparison has to be lexicographic over BOTH key columns: the plain
        // `occurredAt < cursor` a single-column cursor would generate drops
        // every other event sharing that timestamp, and a burst of events from
        // one request shares it routinely.
        const keyset: Prisma.AuditEventWhereInput | undefined = cursor
            ? {
                OR: [
                    { occurredAt: { lt: cursor.occurredAt } },
                    {
                        occurredAt: cursor.occurredAt,
                        eventId: { lt: cursor.eventId },
                    },
                ],
            }
            : undefined;

        // One extra row tells us whether a further page exists without a
        // second COUNT query over a partitioned table.
        const rows = await this.prisma.auditEvent.findMany({
            where: keyset ? { AND: [where, keyset] } : where,
            orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
            take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const events = hasMore ? rows.slice(0, limit) : rows;
        const last = events.at(-1);

        return {
            events,
            nextCursor:
                hasMore && last ? { occurredAt: last.occurredAt, eventId: last.eventId } : null,
        };
    }

    /** Every event sharing a correlation id — one request, reassembled. */
    findByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
        return this.prisma.auditEvent.findMany({
            where: { correlationId },
            orderBy: [{ occurredAt: 'asc' }, { insertedAt: 'asc' }],
        });
    }

    /**
     * How many rows at each severity are older than that severity's cutoff.
     * Read-only: this reports what a prune sweep would remove so an operator
     * can check a policy change before it destroys anything, and it is the
     * closest this package comes to deleting a row.
     */
    countOlderThan(severity: AuditSeverity, cutoff: Date): Promise<number> {
        return this.prisma.auditEvent.count({
            where: { severity, occurredAt: { lt: cutoff } },
        });
    }
}
