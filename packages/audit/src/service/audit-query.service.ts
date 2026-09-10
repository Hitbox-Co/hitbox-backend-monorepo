import { AuditActionResult } from '@hitbox/database';
import type { AuditEvent } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { AUDIT_ERROR_CODES } from '../constants/audit.constant';
import type {
    AuditActor,
    AuditRequestContext,
    IAuditRecorder,
} from '../domain/interfaces/audit-recorder.interface';
import { encodeCursor, decodeCursor } from '../dto/audit-cursor';
import type { AuditEventQuery, AuditExportQuery } from '../dto/audit.dto';
import type {
    AuditEventCursor,
    AuditEventFilter,
    AuditEventRepository,
} from '../repository/audit-event.repository';

/**
 * How far a reader may see.
 *
 * Resolved by bootstrap from the caller's granted permission scope and passed
 * in, exactly as `resolvePrincipalId` is in access-control — so this package
 * enforces the boundary without importing the authorization engine, and a
 * change to how scopes are represented there does not reach in here.
 */
export type AuditReaderScope =
    | { kind: 'GLOBAL' }
    | { kind: 'ORGANIZATION'; organizationId: string };

/** Who is reading, so the read is itself recorded. */
export interface AuditReader {
    actor: AuditActor;
    scope: AuditReaderScope;
    correlationId: string;
    request?: AuditRequestContext;
}

export interface AuditEventPageResponse {
    events: AuditEvent[];
    /** Opaque; pass back as `cursor`. Null on the last page. */
    nextCursor: string | null;
}

export interface AuditQueryServiceDeps {
    events: AuditEventRepository;
    /**
     * Reading the trail is itself an event. Injected as the port rather than
     * the service so this stays testable with NOOP_AUDIT_RECORDER.
     */
    recorder: IAuditRecorder;
    logger: Logger;
}

/**
 * The read side of the trail.
 *
 * Two rules hold for every method here: the reader's scope narrows the query
 * before it reaches the database (never after — filtering in memory would mean
 * another tenant's rows were already loaded), and the read is recorded.
 */
export class AuditQueryService {
    constructor(private readonly deps: AuditQueryServiceDeps) { }

    async list(reader: AuditReader, query: AuditEventQuery): Promise<AuditEventPageResponse> {
        const filter = this.scopedFilter(reader.scope, toFilter(query));
        const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

        const page = await this.deps.events.findPage(filter, query.limit, cursor);

        // Best-effort: a reviewer opening the audit screen must not get a 500
        // because the trail could not record that they opened it. The read
        // happened either way, and the dropped write is logged and alerted on.
        this.deps.recorder.emit({
            eventType: 'audit.read',
            actor: reader.actor,
            result: AuditActionResult.SUCCESS,
            organizationId: this.organizationIdOf(reader.scope),
            resource: { type: 'audit-event' },
            correlationId: reader.correlationId,
            ...(reader.request ? { request: reader.request } : {}),
            metadata: {
                scope: reader.scope.kind,
                filter: describeFilter(filter),
                limit: query.limit,
                returned: page.events.length,
                paged: Boolean(query.cursor),
            },
        });

        return {
            events: page.events,
            nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        };
    }

    /**
     * One request's events, in the order they happened — the refund approval
     * and the ledger write it caused, side by side.
     *
     * Scoped after the fetch rather than before, uniquely here: a correlation
     * can legitimately span a tenant-owned action and the platform-level
     * events it triggered (`organizationId` null), and an org reader should see
     * their own action without the rows that are not theirs. The correlation id
     * is unguessable, but that is not what makes this safe — the filter below
     * is.
     */
    async getCorrelation(reader: AuditReader, correlationId: string): Promise<AuditEvent[]> {
        const events = await this.deps.events.findByCorrelationId(correlationId);
        const organizationId = this.organizationIdOf(reader.scope);
        const visible = organizationId
            ? events.filter((event) => event.organizationId === organizationId)
            : events;

        this.deps.recorder.emit({
            eventType: 'audit.read',
            actor: reader.actor,
            result: AuditActionResult.SUCCESS,
            organizationId,
            resource: { type: 'audit-event' },
            correlationId: reader.correlationId,
            ...(reader.request ? { request: reader.request } : {}),
            metadata: {
                scope: reader.scope.kind,
                lookup: 'correlation',
                correlationRequested: correlationId,
                returned: visible.length,
            },
        });

        return visible;
    }

    /**
     * Bulk export, as an async iterator over keyset pages.
     *
     * The `audit.export` event is recorded — awaited, CRITICAL — *before* the
     * first row is read, so an export that dies or is abandoned halfway is
     * still on the record. Recording it after would mean the one operation
     * most worth catching is the one a client can avoid logging by hanging up.
     */
    async *streamExport(
        reader: AuditReader,
        query: AuditExportQuery,
    ): AsyncGenerator<AuditEvent[], void, undefined> {
        const filter = this.scopedFilter(reader.scope, {
            ...(query.eventType ? { eventType: query.eventType } : {}),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.severity ? { severity: query.severity } : {}),
            from: query.from,
            to: query.to,
        });

        await this.deps.recorder.record({
            eventType: 'audit.export',
            actor: reader.actor,
            result: AuditActionResult.SUCCESS,
            organizationId: this.organizationIdOf(reader.scope),
            resource: { type: 'audit-event' },
            correlationId: reader.correlationId,
            ...(reader.request ? { request: reader.request } : {}),
            metadata: {
                scope: reader.scope.kind,
                filter: describeFilter(filter),
                reason: query.reason,
            },
        });

        this.deps.logger.warn(
            {
                actorId: reader.actor.id ?? null,
                scope: reader.scope.kind,
                from: query.from.toISOString(),
                to: query.to.toISOString(),
            },
            'audit trail export started',
        );

        // Fixed internal page size: the caller does not choose it, because the
        // export is a complete window by definition and the page size is only
        // about how much is held in memory at once.
        const pageSize = 500;
        let cursor: AuditEventCursor | undefined;

        do {
            const page = await this.deps.events.findPage(filter, pageSize, cursor);
            if (page.events.length > 0) yield page.events;
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
    }

    /**
     * Narrows a requested filter to what the reader may see.
     *
     * An ORG-scoped reader gets `organizationId` pinned to their own, and
     * asking for another organization is a 403 rather than an empty page: a
     * silent empty result would let someone probe which org ids exist by
     * watching for the difference between "no events" and "not allowed".
     */
    private scopedFilter(scope: AuditReaderScope, query: AuditEventFilter): AuditEventFilter {
        if (scope.kind === 'GLOBAL') return query;

        if (query.organizationId && query.organizationId !== scope.organizationId) {
            throw AppError.forbidden(
                'You may only read the audit trail for your own organization',
                AUDIT_ERROR_CODES.CROSS_TENANT_READ,
            );
        }
        return { ...query, organizationId: scope.organizationId };
    }

    private organizationIdOf(scope: AuditReaderScope): string | null {
        return scope.kind === 'ORGANIZATION' ? scope.organizationId : null;
    }
}

/**
 * Picks the filtering fields out of a parsed query, dropping `limit` and
 * `cursor`.
 *
 * Explicit rather than a spread: the query DTO and the `where` clause are
 * different shapes that happen to overlap, and spreading one into the other
 * sends paging controls to the database as if they were columns — which Prisma
 * rejects at runtime, on a route that looked fine in review. Adding a filter
 * means adding it here, deliberately, which is also where its index gets
 * thought about.
 */
function toFilter(query: AuditEventQuery): AuditEventFilter {
    return {
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.actionResult ? { actionResult: query.actionResult } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.correlationId ? { correlationId: query.correlationId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
    };
}

/**
 * The filter as it was actually applied, for the `audit.read` metadata —
 * post-scoping, so the record shows the query that ran rather than the one
 * that was asked for. Dates go to ISO strings because this lands in a Json
 * column.
 */
function describeFilter(filter: AuditEventFilter): Record<string, string> {
    const described: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
        if (value === undefined) continue;
        described[key] = value instanceof Date ? value.toISOString() : String(value);
    }
    return described;
}
