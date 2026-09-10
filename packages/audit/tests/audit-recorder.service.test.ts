import { beforeEach, describe, expect, it } from '@jest/globals';
import { AuditActionResult, AuditActorType, AuditSeverity } from '@hitbox/database';
import { AUDIT_ERROR_CODES, AUDIT_EVENTS } from '../src/constants/audit.constant';
import { AuditRecorderService } from '../src/service/audit-recorder.service';
import {
    ADMIN_ACTOR,
    CORRELATION,
    FIXED_NOW,
    FakeEventRepository,
    FakeEventTypeRepository,
    ORG_A,
    TX_MARKER,
    fakeEventBus,
    fakeLogger,
} from './helpers';
import type { CapturingLogger, FakeEventBus } from './helpers';

/** Lets the floating promise inside emit() settle before assertions run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AuditRecorderService', () => {
    let events: FakeEventRepository;
    let eventTypes: FakeEventTypeRepository;
    let eventBus: FakeEventBus;
    let logger: CapturingLogger;
    let recorder: AuditRecorderService;

    beforeEach(() => {
        events = new FakeEventRepository();
        eventTypes = new FakeEventTypeRepository();
        eventBus = fakeEventBus();
        logger = fakeLogger();
        recorder = new AuditRecorderService({
            events: events.asRepository(),
            eventTypes: eventTypes.asRepository(),
            eventBus,
            logger,
            now: () => FIXED_NOW,
        });
    });

    const roleAssign = {
        eventType: 'role.assign',
        actor: ADMIN_ACTOR,
        result: AuditActionResult.SUCCESS,
        organizationId: ORG_A,
        resource: { type: 'role', id: '77777777-7777-4777-8777-777777777777' },
        correlationId: CORRELATION,
        afterState: { roleKey: 'PRODUCT_MANAGER' },
        metadata: { grantedPermissions: ['product:create:organization'] },
    };

    describe('record', () => {
        it('writes the row the catalog describes', async () => {
            await recorder.record(roleAssign);

            expect(events.appended).toHaveLength(1);
            const row = events.appended[0]!;
            expect(row.eventType).toBe('role.assign');
            // Severity comes from the catalog, not the call site — that is what
            // stops a controller from forgetting a grant is critical.
            expect(row.severity).toBe(AuditSeverity.CRITICAL);
            expect(row.actorId).toBe(ADMIN_ACTOR.id);
            expect(row.actorRoleSnapshot).toBe('HITBOX_SYSTEM_ADMIN');
            expect(row.organizationId).toBe(ORG_A);
            expect(row.correlationId).toBe(CORRELATION);
        });

        it('generates a distinct eventId per event', async () => {
            await recorder.record(roleAssign);
            await recorder.record(roleAssign);
            expect(events.appended[0]!.eventId).not.toBe(events.appended[1]!.eventId);
        });

        it('defaults metadata to an object, never null', async () => {
            const { metadata: _metadata, ...withoutMetadata } = roleAssign;
            await recorder.record(withoutMetadata);
            expect(events.appended[0]!.metadata).toEqual({});
        });

        it('records insertedAt separately from occurredAt', async () => {
            const backdated = new Date('2026-09-09T08:00:00.000Z');
            await recorder.record({ ...roleAssign, occurredAt: backdated });

            const row = events.appended[0]!;
            expect(row.occurredAt).toEqual(backdated);
            // The write time is never the caller's, so clock skew and late
            // writes stay visible instead of being smoothed away.
            expect(row.insertedAt).toEqual(FIXED_NOW);
        });

        it('passes the caller transaction through, so both commit together', async () => {
            await recorder.record(roleAssign, { tx: TX_MARKER });
            expect(events.transactions[0]).toBe(TX_MARKER);
        });

        it('fails the operation when the row cannot be written', async () => {
            events.failAppend = true;

            await expect(recorder.record(roleAssign)).rejects.toMatchObject({
                code: AUDIT_ERROR_CODES.WRITE_FAILED,
                statusCode: 500,
            });
            expect(logger.errors).toHaveLength(1);
        });

        it('refuses an unregistered event type', async () => {
            await expect(
                recorder.record({ ...roleAssign, eventType: 'not.registered' }),
            ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.UNKNOWN_EVENT_TYPE });
            expect(events.appended).toHaveLength(0);
        });

        it('refuses an event with no correlation id', async () => {
            await expect(recorder.record({ ...roleAssign, correlationId: '' })).rejects.toMatchObject(
                { code: AUDIT_ERROR_CODES.MISSING_CORRELATION_ID },
            );
        });
    });

    describe('severity', () => {
        it('downgrades a denial to WARNING', async () => {
            // product.delete is CRITICAL, but a refused delete changed nothing.
            // Left at CRITICAL, routine denials would bury the rows a review is
            // meant to read one by one.
            await recorder.record({
                ...roleAssign,
                eventType: 'product.delete',
                result: AuditActionResult.DENIED,
                metadata: { reason: 'resource policy denied' },
            });
            expect(events.appended[0]!.severity).toBe(AuditSeverity.WARNING);
        });

        it('keeps the catalog severity for a failure', async () => {
            // A refund that errored halfway is at least as serious as one that
            // worked, so FAILURE does not get the denial's downgrade.
            await recorder.record({
                ...roleAssign,
                eventType: 'order.refund',
                result: AuditActionResult.FAILURE,
            });
            expect(events.appended[0]!.severity).toBe(AuditSeverity.CRITICAL);
        });

        it('lets an explicit severity win', async () => {
            await recorder.record({
                ...roleAssign,
                result: AuditActionResult.DENIED,
                severity: AuditSeverity.CRITICAL,
            });
            expect(events.appended[0]!.severity).toBe(AuditSeverity.CRITICAL);
        });
    });

    describe('operator-registered event types', () => {
        it('falls back to the table for a key absent from the code catalog', async () => {
            eventTypes.rows.set('vendor.blacklist', {
                defaultSeverity: AuditSeverity.CRITICAL,
                isActive: true,
            });

            await recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' });
            expect(events.appended[0]!.severity).toBe(AuditSeverity.CRITICAL);
        });

        it('memoises the lookup rather than hitting the table per event', async () => {
            eventTypes.rows.set('vendor.blacklist', {
                defaultSeverity: AuditSeverity.WARNING,
                isActive: true,
            });

            await recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' });
            await recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' });
            expect(eventTypes.lookups).toEqual(['vendor.blacklist']);
        });

        it('never consults the table for a key the code catalog knows', async () => {
            await recorder.record(roleAssign);
            expect(eventTypes.lookups).toEqual([]);
        });

        it('does not cache a miss, so registering a type works without a restart', async () => {
            await expect(
                recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' }),
            ).rejects.toMatchObject({ code: AUDIT_ERROR_CODES.UNKNOWN_EVENT_TYPE });

            eventTypes.rows.set('vendor.blacklist', {
                defaultSeverity: AuditSeverity.WARNING,
                isActive: true,
            });

            await recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' });
            expect(events.appended).toHaveLength(1);
        });

        it('still records against a retired type, and warns', async () => {
            eventTypes.rows.set('vendor.blacklist', {
                defaultSeverity: AuditSeverity.WARNING,
                isActive: false,
            });

            // Refusing would turn a catalog tidy-up into an outage on whatever
            // path still calls it; the warning is the signal to fix the caller.
            await recorder.record({ ...roleAssign, eventType: 'vendor.blacklist' });
            expect(events.appended).toHaveLength(1);
            expect(logger.warnings).toHaveLength(1);
        });
    });

    describe('emit', () => {
        const denial = {
            eventType: 'product.delete',
            actor: { type: AuditActorType.BRAND_EMPLOYEE, id: ADMIN_ACTOR.id },
            result: AuditActionResult.DENIED,
            organizationId: ORG_A,
            correlationId: CORRELATION,
            metadata: { reason: 'resource policy denied' },
        };

        it('writes the row', async () => {
            recorder.emit(denial);
            await flush();

            expect(events.appended).toHaveLength(1);
            expect(events.appended[0]!.actionResult).toBe(AuditActionResult.DENIED);
        });

        it('returns synchronously, so a caller cannot await the database', () => {
            // The return type is the guarantee: a Promise here would invite
            // `await audit.emit(...)`, putting the audit write back on the
            // request path this method exists to keep it off.
            expect(recorder.emit(denial)).toBeUndefined();
        });

        it('never throws when the write fails', async () => {
            events.failAppend = true;

            expect(() => recorder.emit(denial)).not.toThrow();
            await flush();

            expect(logger.errors).toHaveLength(1);
            expect(eventBus.published).toEqual([
                {
                    event: AUDIT_EVENTS.WRITE_DROPPED,
                    payload: {
                        eventType: 'product.delete',
                        correlationId: CORRELATION,
                        result: AuditActionResult.DENIED,
                    },
                },
            ]);
        });

        it('never throws for an unregistered event type', async () => {
            expect(() => recorder.emit({ ...denial, eventType: 'not.registered' })).not.toThrow();
            await flush();

            expect(events.appended).toHaveLength(0);
            expect(logger.errors).toHaveLength(1);
        });

        it('survives the bus failing while reporting a dropped write', async () => {
            events.failAppend = true;
            eventBus.failOnPublish = true;

            expect(() => recorder.emit(denial)).not.toThrow();
            await flush();

            // Nothing above emit() can act on a bus failure, and throwing here
            // would defeat the method's entire contract.
            expect(logger.errors).toHaveLength(1);
        });
    });
});
