import { describe, expect, it } from '@jest/globals';
import { AuditActionResult, AuditSeverity } from '@hitbox/database';
import { AUDIT_ERROR_CODES, AUDIT_QUERY_MAX_LIMIT } from '../src/constants/audit.constant';
import { decodeCursor, encodeCursor } from '../src/dto/audit-cursor';
import {
    auditEventQuerySchema,
    auditExportQuerySchema,
    updateRetentionPolicySchema,
} from '../src/dto/audit.dto';
import { CORRELATION, FIXED_NOW, ORG_A } from './helpers';

describe('audit cursor', () => {
    const cursor = { occurredAt: FIXED_NOW, eventId: CORRELATION };

    it('round-trips a position', () => {
        expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it('is opaque, so clients cannot hand-roll one from a timestamp', () => {
        const encoded = encodeCursor(cursor);
        expect(encoded).not.toContain(FIXED_NOW.toISOString());
        expect(encoded).not.toContain(CORRELATION);
    });

    it.each([
        ['not base64 at all', 'not-a-cursor'],
        ['valid base64 that is not JSON', Buffer.from('nonsense').toString('base64url')],
        ['JSON of the wrong shape', Buffer.from('{"x":1}').toString('base64url')],
        [
            'an unparseable date',
            Buffer.from(`{"o":"never","e":"${CORRELATION}"}`).toString('base64url'),
        ],
        [
            // Otherwise this reaches a uuid column and returns a 500 from a
            // cast failure instead of the 400 a bad cursor deserves.
            'an eventId that is not a uuid',
            Buffer.from('{"o":"2026-09-10T00:00:00.000Z","e":"1 OR 1=1"}').toString('base64url'),
        ],
    ])('rejects %s', (_label, raw) => {
        expect(() => decodeCursor(raw)).toThrow(
            expect.objectContaining({ code: AUDIT_ERROR_CODES.INVALID_CURSOR }),
        );
    });
});

describe('auditEventQuerySchema', () => {
    it('defaults to a bounded page', () => {
        const query = auditEventQuerySchema.parse({});
        expect(query.limit).toBeLessThanOrEqual(AUDIT_QUERY_MAX_LIMIT);
        expect(query.limit).toBeGreaterThan(0);
    });

    it('refuses a page larger than the cap', () => {
        // The trail is the largest table in the platform; an unbounded limit
        // is a self-service outage.
        expect(() => auditEventQuerySchema.parse({ limit: AUDIT_QUERY_MAX_LIMIT + 1 })).toThrow();
    });

    it('coerces the limit and the dates from query strings', () => {
        const query = auditEventQuerySchema.parse({
            limit: '25',
            from: '2026-09-01T00:00:00.000Z',
        });
        expect(query.limit).toBe(25);
        expect(query.from).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it('accepts every filter the indexes support', () => {
        const query = auditEventQuerySchema.parse({
            eventType: 'role.assign',
            actorId: ORG_A,
            organizationId: ORG_A,
            resourceType: 'role',
            resourceId: ORG_A,
            actionResult: AuditActionResult.DENIED,
            severity: AuditSeverity.WARNING,
            correlationId: CORRELATION,
        });
        expect(query.eventType).toBe('role.assign');
        expect(query.actionResult).toBe(AuditActionResult.DENIED);
    });

    it('rejects an inverted time window', () => {
        expect(() =>
            auditEventQuerySchema.parse({
                from: '2026-09-10T00:00:00.000Z',
                to: '2026-09-01T00:00:00.000Z',
            }),
        ).toThrow();
    });

    it('requires resourceType alongside resourceId', () => {
        // Ids are only unique within a type, and the pair is what the index is
        // on — alone, resourceId would scan the table and mix a product with a
        // role that happens to share an id.
        expect(() => auditEventQuerySchema.parse({ resourceId: ORG_A })).toThrow();
        expect(() =>
            auditEventQuerySchema.parse({ resourceId: ORG_A, resourceType: 'product' }),
        ).not.toThrow();
    });

    it('rejects a non-uuid actor id', () => {
        expect(() => auditEventQuerySchema.parse({ actorId: 'bob' })).toThrow();
    });

    it('accepts an event type the code catalog does not know', () => {
        // An operator may have registered it directly; refusing to search for
        // it would hide rows that exist.
        expect(() => auditEventQuerySchema.parse({ eventType: 'vendor.blacklist' })).not.toThrow();
    });
});

describe('auditExportQuerySchema', () => {
    const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };

    it('requires a bounded window and a reason', () => {
        expect(() => auditExportQuerySchema.parse(window)).toThrow();
        expect(() =>
            auditExportQuerySchema.parse({ ...window, reason: 'Quarterly compliance review' }),
        ).not.toThrow();
    });

    it('refuses a token reason', () => {
        // "who pulled the whole trail, and what for?" has to be answerable
        // from the trail itself.
        expect(() => auditExportQuerySchema.parse({ ...window, reason: 'because' })).toThrow();
    });

    it('rejects an inverted window', () => {
        expect(() =>
            auditExportQuerySchema.parse({
                from: window.to,
                to: window.from,
                reason: 'Quarterly compliance review',
            }),
        ).toThrow();
    });
});

describe('updateRetentionPolicySchema', () => {
    it('requires a note explaining the change', () => {
        expect(() => updateRetentionPolicySchema.parse({ retentionDays: 30 })).toThrow();
        expect(() =>
            updateRetentionPolicySchema.parse({ retentionDays: 30, notes: 'Storage review 2026' }),
        ).not.toThrow();
    });

    it('refuses a window of zero days', () => {
        // Zero would make the next sweep delete everything at that severity,
        // and "I meant to type 30" should not be able to do that.
        expect(() =>
            updateRetentionPolicySchema.parse({ retentionDays: 0, notes: 'Storage review 2026' }),
        ).toThrow();
    });

    it('refuses a fractional day count', () => {
        expect(() =>
            updateRetentionPolicySchema.parse({ retentionDays: 1.5, notes: 'Storage review 2026' }),
        ).toThrow();
    });
});
