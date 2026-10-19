import { beforeEach, describe, expect, it } from '@jest/globals';
import { AuditActionResult, AuditSeverity } from '@hitbox/database';
import { AUDIT_ERROR_CODES } from '../src/constants/audit.constant';
import { AuditQueryService } from '../src/service/audit-query.service';
import type { AuditReader } from '../src/service/audit-query.service';
import type { AuditRecordInput, IAuditRecorder } from '../src/domain/interfaces/audit-recorder.interface';
import { auditEventQuerySchema } from '../src/dto/audit.dto';
import {
    ADMIN_ACTOR,
    CORRELATION,
    FIXED_NOW,
    FakeEventRepository,
    ORG_A,
    ORG_B,
    auditEventRow,
    fakeLogger,
} from './helpers';

/** Records what the service asked to be audited. */
function spyRecorder() {
    const recorded: AuditRecordInput[] = [];
    const emitted: AuditRecordInput[] = [];
    let failRecord = false;

    const recorder: IAuditRecorder = {
        record: async (input) => {
            if (failRecord) throw new Error('audit write failed');
            recorded.push(input);
        },
        emit: (input) => {
            emitted.push(input);
        },
    };

    return {
        recorder,
        recorded,
        emitted,
        failNextRecord: () => {
            failRecord = true;
        },
    };
}

const GLOBAL_READER: AuditReader = {
    actor: ADMIN_ACTOR,
    scope: { kind: 'GLOBAL' },
    correlationId: CORRELATION,
    request: { ipAddress: '203.0.113.7' },
};

const ORG_READER: AuditReader = {
    actor: ADMIN_ACTOR,
    scope: { kind: 'ORGANIZATION', organizationId: ORG_A },
    correlationId: CORRELATION,
};

/** Parses through the DTO, so tests exercise the same defaults the route does. */
const query = (raw: Record<string, unknown> = {}) => auditEventQuerySchema.parse(raw);

describe('AuditQueryService', () => {
    let events: FakeEventRepository;
    let spy: ReturnType<typeof spyRecorder>;
    let service: AuditQueryService;

    beforeEach(() => {
        events = new FakeEventRepository();
        spy = spyRecorder();
        service = new AuditQueryService({
            events: events.asRepository(),
            recorder: spy.recorder,
            logger: fakeLogger(),
        });
    });

    describe('scoping', () => {
        it('pins an org reader to their own organization', async () => {
            events.rows = [
                auditEventRow({ eventId: 'a', organizationId: ORG_A }),
                auditEventRow({ eventId: 'b', organizationId: ORG_B }),
            ];

            const page = await service.list(ORG_READER, query());

            // Narrowed before the query runs, not after: filtering in memory
            // would mean the other tenant's rows had already been loaded.
            expect(events.pageCalls[0]!.filter.organizationId).toBe(ORG_A);
            expect(page.events.map((event) => event.eventId)).toEqual(['a']);
        });

        it('refuses an org reader asking for another organization', async () => {
            await expect(
                service.list(ORG_READER, query({ organizationId: ORG_B })),
            ).rejects.toMatchObject({
                code: AUDIT_ERROR_CODES.CROSS_TENANT_READ,
                statusCode: 403,
            });
        });

        it('rejects rather than returning an empty page', async () => {
            // An empty result would let someone probe which org ids exist by
            // watching for the difference between "no events" and "not yours".
            const rejection = await service
                .list(ORG_READER, query({ organizationId: ORG_B }))
                .catch((error: unknown) => error);
            expect(rejection).toBeInstanceOf(Error);
            expect(events.pageCalls).toHaveLength(0);
        });

        it('allows an org reader to name their own organization', async () => {
            await service.list(ORG_READER, query({ organizationId: ORG_A }));
            expect(events.pageCalls[0]!.filter.organizationId).toBe(ORG_A);
        });

        it('leaves a global reader unfiltered', async () => {
            await service.list(GLOBAL_READER, query());
            expect(events.pageCalls[0]!.filter.organizationId).toBeUndefined();
        });

        it('lets a global reader filter to one organization', async () => {
            await service.list(GLOBAL_READER, query({ organizationId: ORG_B }));
            expect(events.pageCalls[0]!.filter.organizationId).toBe(ORG_B);
        });
    });

    describe('paging', () => {
        it('returns an opaque cursor and resumes from it', async () => {
            events.rows = [
                auditEventRow({ eventId: '11111111-1111-4111-8111-000000000001' }),
                auditEventRow({ eventId: '11111111-1111-4111-8111-000000000002' }),
                auditEventRow({ eventId: '11111111-1111-4111-8111-000000000003' }),
            ];

            const first = await service.list(GLOBAL_READER, query({ limit: 2 }));
            expect(first.events).toHaveLength(2);
            expect(first.nextCursor).toBeTruthy();

            const second = await service.list(
                GLOBAL_READER,
                query({ limit: 2, cursor: first.nextCursor! }),
            );
            expect(second.events.map((event) => event.eventId)).toEqual([
                '11111111-1111-4111-8111-000000000003',
            ]);
            expect(second.nextCursor).toBeNull();
        });

        it('rejects a cursor it did not issue', async () => {
            await expect(
                service.list(GLOBAL_READER, query({ cursor: 'not-a-cursor' })),
            ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.INVALID_CURSOR });
        });

        it('caps the page at the requested limit', async () => {
            await service.list(GLOBAL_READER, query({ limit: 7 }));
            expect(events.pageCalls[0]!.limit).toBe(7);
        });
    });

    describe('recording the read', () => {
        it('emits audit.read best-effort rather than recording it', async () => {
            await service.list(GLOBAL_READER, query());

            // A reviewer opening the screen must not get a 500 because the
            // trail could not record that they opened it.
            expect(spy.recorded).toHaveLength(0);
            expect(spy.emitted).toHaveLength(1);
            expect(spy.emitted[0]!.eventType).toBe('audit.read');
            expect(spy.emitted[0]!.result).toBe(AuditActionResult.SUCCESS);
        });

        it('records the filter that actually ran, not the one requested', async () => {
            await service.list(ORG_READER, query({ severity: AuditSeverity.CRITICAL }));

            const metadata = spy.emitted[0]!.metadata as {
                scope: string;
                filter: Record<string, string>;
            };
            expect(metadata.scope).toBe('ORGANIZATION');
            expect(metadata.filter.organizationId).toBe(ORG_A);
            expect(metadata.filter.severity).toBe(AuditSeverity.CRITICAL);
        });

        it('serialises dates in the recorded filter', async () => {
            const from = new Date('2026-09-01T00:00:00.000Z');
            await service.list(GLOBAL_READER, query({ from: from.toISOString() }));

            const metadata = spy.emitted[0]!.metadata as { filter: Record<string, string> };
            expect(metadata.filter.from).toBe(from.toISOString());
        });
    });

    describe('getCorrelation', () => {
        it('hides another organization rows from an org reader', async () => {
            events.rows = [
                auditEventRow({ eventId: 'mine', organizationId: ORG_A }),
                auditEventRow({ eventId: 'theirs', organizationId: ORG_B }),
                auditEventRow({ eventId: 'platform', organizationId: null }),
            ];

            const visible = await service.getCorrelation(ORG_READER, CORRELATION);
            expect(visible.map((event) => event.eventId)).toEqual(['mine']);
        });

        it('gives a global reader the whole correlation', async () => {
            events.rows = [
                auditEventRow({ eventId: 'mine', organizationId: ORG_A }),
                auditEventRow({ eventId: 'platform', organizationId: null }),
            ];

            const visible = await service.getCorrelation(GLOBAL_READER, CORRELATION);
            expect(visible).toHaveLength(2);
        });
    });

    describe('streamExport', () => {
        const exportQuery = {
            from: new Date('2026-09-01T00:00:00.000Z'),
            to: new Date('2026-10-01T00:00:00.000Z'),
            reason: 'Quarterly compliance review for the finance team',
        };

        it('records audit.export before reading a single row', async () => {
            events.rows = [auditEventRow({ eventId: 'a', occurredAt: FIXED_NOW })];

            const iterator = service.streamExport(GLOBAL_READER, exportQuery);
            await iterator.next();

            expect(spy.recorded).toHaveLength(1);
            expect(spy.recorded[0]!.eventType).toBe('audit.export');
            expect(spy.recorded[0]!.metadata).toMatchObject({ reason: exportQuery.reason });
        });

        it('reads nothing when the export cannot be recorded', async () => {
            events.rows = [auditEventRow({ eventId: 'a', occurredAt: FIXED_NOW })];
            spy.failNextRecord();

            const iterator = service.streamExport(GLOBAL_READER, exportQuery);
            await expect(iterator.next()).rejects.toThrow('audit write failed');

            // Otherwise the one operation most worth catching would be the one
            // a client can avoid logging by hanging up.
            expect(events.pageCalls).toHaveLength(0);
        });

        it('scopes an org reader export to their own organization', async () => {
            const iterator = service.streamExport(ORG_READER, exportQuery);
            await iterator.next();
            expect(events.pageCalls[0]!.filter.organizationId).toBe(ORG_A);
        });

        it('yields every page of the window', async () => {
            events.rows = Array.from({ length: 3 }, (_unused, index) =>
                auditEventRow({
                    eventId: `1111111-1111-4111-8111-00000000000${index}`,
                    occurredAt: FIXED_NOW,
                }),
            );

            const seen: string[] = [];
            for await (const batch of service.streamExport(GLOBAL_READER, exportQuery)) {
                seen.push(...batch.map((event) => event.eventId));
            }
            expect(seen).toHaveLength(3);
        });
    });
});
