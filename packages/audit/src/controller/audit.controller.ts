import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { AUDIT_EVENT_CATALOG } from '../domain/audit-event-catalog';
import {
    auditEventQuerySchema,
    auditExportQuerySchema,
    listEventTypesQuerySchema,
    retentionSeverityParamSchema,
    updateRetentionPolicySchema,
} from '../dto/audit.dto';
import type { AuditEventTypeRepository } from '../repository/audit-event-type.repository';
import type { AuditQueryService, AuditReader } from '../service/audit-query.service';
import type { AuditRetentionService } from '../service/audit-retention.service';

/**
 * Builds the `AuditReader` for a request — who is asking and how far they may
 * see.
 *
 * Injected, like access-control's `resolvePrincipalId`: bootstrap knows how to
 * turn `req.auth` and `req.authz` into an actor and a scope, and this package
 * deliberately does not, so it depends on neither the identity provider nor
 * the authorization engine.
 */
export type AuditReaderResolver = (req: Request) => AuditReader | Promise<AuditReader>;

export class AuditController {
    constructor(
        private readonly query: AuditQueryService,
        private readonly retention: AuditRetentionService,
        private readonly eventTypes: AuditEventTypeRepository,
        private readonly resolveReader: AuditReaderResolver,
    ) { }

    // ── The trail ───────────────────────────────────────────────────────────

    /** GET /admin/audit/events */
    listEvents: RequestHandler = asyncHandler(async (req, res) => {
        const query = auditEventQuerySchema.parse(req.query);
        const reader = await this.resolveReader(req);
        const page = await this.query.list(reader, query);

        res.json({
            data: page.events,
            meta: {
                limit: query.limit,
                returned: page.events.length,
                nextCursor: page.nextCursor,
                // No total. A COUNT over a partitioned, append-only table of
                // this size costs more than the page itself and is stale by
                // the time it is rendered.
                hasMore: page.nextCursor !== null,
            },
        });
    });

    /**
     * GET /admin/audit/events/correlation/:correlationId
     *
     * One request, reassembled in the order it happened.
     */
    getCorrelation: RequestHandler = asyncHandler(async (req, res) => {
        const reader = await this.resolveReader(req);
        const events = await this.query.getCorrelation(
            reader,
            req.params.correlationId as string,
        );
        res.json({ data: events, meta: { returned: events.length } });
    });

    /**
     * GET /admin/audit/export
     *
     * Newline-delimited JSON, streamed. Not an array: a legal export covers a
     * window that does not fit in memory or in one JSON document, and NDJSON
     * lets the client process it as it arrives.
     *
     * The `audit.export` event is recorded before the first row is read (see
     * AuditQueryService.streamExport), so an abandoned export is still on the
     * record.
     */
    exportEvents: RequestHandler = asyncHandler(async (req, res) => {
        const query = auditExportQuerySchema.parse(req.query);
        const reader = await this.resolveReader(req);

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="audit-${query.from.toISOString().slice(0, 10)}-to-${query.to
                .toISOString()
                .slice(0, 10)}.ndjson"`,
        );

        for await (const batch of this.query.streamExport(reader, query)) {
            const chunk = batch.map((event) => JSON.stringify(event)).join('\n');
            // Respect backpressure: without this a large window buffers the
            // whole export in the process while a slow client trickles.
            if (!res.write(`${chunk}\n`)) {
                await new Promise<void>((resolve) => res.once('drain', resolve));
            }
        }

        res.end();
    });

    // ── The event catalog ───────────────────────────────────────────────────

    /**
     * GET /admin/audit/event-types
     *
     * Returns the table, not the code catalog, because the table is what the
     * trail's foreign keys point at — including any event an operator
     * registered directly. `?source=code` returns the code catalog instead, to
     * diff the two when a sync is in question.
     */
    listEventTypes: RequestHandler = asyncHandler(async (req, res) => {
        if (req.query.source === 'code') {
            res.json({ data: AUDIT_EVENT_CATALOG, meta: { source: 'code' } });
            return;
        }

        const { includeInactive } = listEventTypesQuerySchema.parse(req.query);
        res.json({
            data: await this.eventTypes.findAll({ includeInactive }),
            meta: { source: 'database', includeInactive },
        });
    });

    // ── Retention ───────────────────────────────────────────────────────────

    /** GET /admin/audit/retention */
    listRetentionPolicies: RequestHandler = asyncHandler(async (req, res) => {
        const withCounts = req.query.withCounts === 'true';
        res.json({ data: await this.retention.list({ withCounts }) });
    });

    /** PATCH /admin/audit/retention/:severity */
    updateRetentionPolicy: RequestHandler = asyncHandler(async (req, res) => {
        const severity = retentionSeverityParamSchema.parse(req.params.severity);
        const dto = updateRetentionPolicySchema.parse(req.body);
        const reader = await this.resolveReader(req);
        res.json({ data: await this.retention.update(reader, severity, dto) });
    });

    /**
     * GET /admin/audit/retention/prune-plan
     *
     * What the next sweep would remove. Reporting only — the pruning job runs
     * outside the application and this endpoint cannot delete anything.
     */
    getPrunePlan: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: await this.retention.prunePlan() });
    });
}
