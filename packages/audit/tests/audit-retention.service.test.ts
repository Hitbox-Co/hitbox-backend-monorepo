import { beforeEach, describe, expect, it } from '@jest/globals';
import { AuditSeverity } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { AUDIT_ERROR_CODES, AUDIT_EVENTS } from '../src/constants/audit.constant';
import { RETENTION_DEFAULTS, retentionCutoff } from '../src/domain/retention-defaults';
import { AuditRecorderService } from '../src/service/audit-recorder.service';
import { AuditRetentionService } from '../src/service/audit-retention.service';
import type { AuditReader } from '../src/service/audit-query.service';
import {
    ADMIN_ACTOR,
    CORRELATION,
    FIXED_NOW,
    FakeEventRepository,
    FakeEventTypeRepository,
    FakePolicyRepository,
    TX_MARKER,
    auditEventRow,
    fakeEventBus,
    fakeLogger,
    fakePrisma,
} from './helpers';
import type { FakeEventBus } from './helpers';

const READER: AuditReader = {
    actor: ADMIN_ACTOR,
    scope: { kind: 'GLOBAL' },
    correlationId: CORRELATION,
};

describe('retention defaults', () => {
    it('covers every severity exactly once', () => {
        // The pruner has no answer for a severity with no policy, so a gap
        // here means those rows are kept forever while an operator believes
        // they expire.
        const severities = RETENTION_DEFAULTS.map((policy) => policy.severity);
        expect(new Set(severities).size).toBe(severities.length);
        expect(new Set(severities)).toEqual(new Set(Object.values(AuditSeverity)));
    });

    it('keeps CRITICAL longest and INFO shortest', () => {
        const byLevel = new Map(
            RETENTION_DEFAULTS.map((policy) => [policy.severity, policy.retentionDays]),
        );
        expect(byLevel.get(AuditSeverity.CRITICAL)!).toBeGreaterThan(
            byLevel.get(AuditSeverity.WARNING)!,
        );
        expect(byLevel.get(AuditSeverity.WARNING)!).toBeGreaterThan(
            byLevel.get(AuditSeverity.INFO)!,
        );
    });

    it('explains every window', () => {
        for (const policy of RETENTION_DEFAULTS) {
            expect(policy.notes.length).toBeGreaterThan(20);
        }
    });

    it('subtracts whole days from the given instant', () => {
        expect(retentionCutoff(90, new Date('2026-09-10T14:22:03.000Z'))).toEqual(
            new Date('2026-06-12T14:22:03.000Z'),
        );
    });

    it('does not mutate the clock it was handed', () => {
        const now = new Date('2026-09-10T14:22:03.000Z');
        retentionCutoff(30, now);
        expect(now.toISOString()).toBe('2026-09-10T14:22:03.000Z');
    });
});

describe('AuditRetentionService', () => {
    let policies: FakePolicyRepository;
    let events: FakeEventRepository;
    let eventTypes: FakeEventTypeRepository;
    let eventBus: FakeEventBus;
    let recorder: AuditRecorderService;
    let service: AuditRetentionService;

    beforeEach(() => {
        policies = new FakePolicyRepository(RETENTION_DEFAULTS.map((policy) => ({ ...policy })));
        events = new FakeEventRepository();
        eventTypes = new FakeEventTypeRepository();
        eventBus = fakeEventBus();
        const logger = fakeLogger();

        recorder = new AuditRecorderService({
            events: events.asRepository(),
            eventTypes: eventTypes.asRepository(),
            eventBus,
            logger,
            now: () => FIXED_NOW,
        });

        service = new AuditRetentionService({
            policies: policies.asRepository(),
            events: events.asRepository(),
            recorder,
            eventBus,
            logger,
            prisma: fakePrisma() as unknown as PrismaClient,
            now: () => FIXED_NOW,
        });
    });

    describe('list', () => {
        it('derives a cutoff for each policy', async () => {
            const views = await service.list();
            const critical = views.find((view) => view.severity === AuditSeverity.CRITICAL)!;
            expect(critical.cutoff).toEqual(retentionCutoff(critical.retentionDays, FIXED_NOW));
        });

        it('omits row counts unless asked, since each is a COUNT over the trail', async () => {
            const views = await service.list();
            expect(views.every((view) => view.pendingDeletion === undefined)).toBe(true);
        });

        it('reports what a sweep would remove when asked', async () => {
            events.rows = [
                auditEventRow({
                    eventId: 'ancient',
                    severity: AuditSeverity.INFO,
                    occurredAt: new Date('2020-01-01T00:00:00.000Z'),
                }),
                auditEventRow({
                    eventId: 'recent',
                    severity: AuditSeverity.INFO,
                    occurredAt: FIXED_NOW,
                }),
            ];

            const views = await service.list({ withCounts: true });
            const info = views.find((view) => view.severity === AuditSeverity.INFO)!;
            expect(info.pendingDeletion).toBe(1);
        });
    });

    describe('update', () => {
        const shorten = { retentionDays: 30, notes: 'Shortened for the storage review' };

        it('changes the window and records it in one transaction', async () => {
            await service.update(READER, AuditSeverity.INFO, shorten);

            expect(policies.updates[0]).toMatchObject({
                severity: AuditSeverity.INFO,
                inTransaction: true,
            });
            // Shortening a window is how evidence gets destroyed, so a version
            // where the record can fail while the change lands is not worth
            // having.
            expect(events.transactions[0]).toBe(TX_MARKER);
        });

        it('records the change as CRITICAL with both snapshots', async () => {
            await service.update(READER, AuditSeverity.INFO, shorten);

            const row = events.appended[0]!;
            expect(row.eventType).toBe('audit.retention-policy.update');
            expect(row.severity).toBe(AuditSeverity.CRITICAL);
            expect(row.beforeState).toMatchObject({ retentionDays: 90 });
            expect(row.afterState).toMatchObject({ retentionDays: 30 });
        });

        it('flags the direction of the change for alerting', async () => {
            await service.update(READER, AuditSeverity.INFO, shorten);
            expect(events.appended[0]!.metadata).toMatchObject({
                direction: 'shortened',
                dayDelta: -60,
            });

            await service.update(READER, AuditSeverity.INFO, {
                retentionDays: 400,
                notes: 'Extended for an open legal hold',
            });
            expect(events.appended[1]!.metadata).toMatchObject({ direction: 'lengthened' });
        });

        it('announces the change only after the commit', async () => {
            await service.update(READER, AuditSeverity.INFO, shorten);
            expect(eventBus.published).toEqual([
                {
                    event: AUDIT_EVENTS.RETENTION_POLICY_CHANGED,
                    payload: {
                        severity: AuditSeverity.INFO,
                        previousRetentionDays: 90,
                        retentionDays: 30,
                    },
                },
            ]);
        });

        it('refuses a severity with no policy row', async () => {
            policies.policies.delete(AuditSeverity.WARNING);
            await expect(
                service.update(READER, AuditSeverity.WARNING, shorten),
            ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.RETENTION_POLICY_MISSING });
        });
    });

    describe('prunePlan', () => {
        it('returns a cutoff and a count per severity', async () => {
            const plan = await service.prunePlan();
            expect(plan).toHaveLength(3);
            expect(plan.every((view) => typeof view.pendingDeletion === 'number')).toBe(true);
        });

        it('refuses to report a plan with a severity missing', async () => {
            // A pruner that silently skipped a severity would keep those rows
            // forever while the operator believed they expired.
            policies.policies.delete(AuditSeverity.INFO);
            await expect(service.prunePlan()).rejects.toMatchObject({
                code: AUDIT_ERROR_CODES.RETENTION_POLICY_MISSING,
            });
        });
    });

    it('exposes no way to delete an event', () => {
        // Pruning drops whole partitions from a scheduled job outside the
        // application, and the app's credentials should not hold DELETE on
        // AuditEvent at all — a prune method here would need exactly the grant
        // that must not exist.
        const surface = Object.getOwnPropertyNames(AuditRetentionService.prototype);
        expect(surface.filter((name) => /prune|delete|purge/i.test(name))).toEqual(['prunePlan']);
    });
});
