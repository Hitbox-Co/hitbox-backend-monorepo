import { describe, expect, it } from '@jest/globals';
import { AuditSeverity } from '@hitbox/database';
import {
    AUDIT_EVENT_CATALOG,
    AUDIT_EVENT_TYPES,
    AuditPersonaGroup,
    findAuditEventType,
    isKnownAuditEventType,
} from '../src/domain/audit-event-catalog';

/**
 * The catalog is the single place that decides what is auditable and how
 * serious it is, which makes it the single place worth asserting against. Every
 * check here is a property of the catalog as a whole, not a restatement of one
 * row — a test that re-listed each event's severity would just be the catalog
 * typed twice, and would pass no matter how wrong the catalog was.
 */
describe('audit event catalog', () => {
    it('registers every event exactly once', () => {
        expect(AUDIT_EVENT_TYPES.size).toBe(AUDIT_EVENT_CATALOG.length);
    });

    it('cites a requirement for every event', () => {
        const uncited = AUDIT_EVENT_CATALOG.filter((event) => event.sourceStories.length === 0);
        expect(uncited).toEqual([]);
    });

    it('names events as lowercase dotted segments', () => {
        // The alerting rules match on prefixes (`eventType LIKE 'role.%'`), so
        // a stray `Role.Assign` would silently drop out of every alert.
        const malformed = AUDIT_EVENT_CATALOG.map((event) => event.eventType).filter(
            (key) => !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(key),
        );
        expect(malformed).toEqual([]);
    });

    it('uses a known persona group for every event', () => {
        const groups = new Set<string>(Object.values(AuditPersonaGroup));
        const unknown = AUDIT_EVENT_CATALOG.filter((event) => !groups.has(event.personaGroup));
        expect(unknown).toEqual([]);
    });

    it('gives a non-empty description to every event', () => {
        const undescribed = AUDIT_EVENT_CATALOG.filter(
            (event) => event.description.trim().length < 10,
        );
        expect(undescribed).toEqual([]);
    });

    /**
     * The old design's "sensitive" flag, now expressed once per event instead
     * of remembered at each call site. If one of these ever drops below
     * CRITICAL, a controller that was relying on the catalog to make it
     * critical stops being audited at that level and nothing else complains.
     */
    it.each([
        'role.assign',
        'role.revoke',
        'role.create',
        'role.update',
        'role.delete',
        'organization.suspend',
        'organization.delete',
        'user.delete',
        'order.refund',
        'refund.process',
        'product.delete',
        'audit.export',
        'audit.retention-policy.update',
    ])('treats %s as CRITICAL', (eventType) => {
        expect(findAuditEventType(eventType)?.defaultSeverity).toBe(AuditSeverity.CRITICAL);
    });

    it('keeps high-volume read paths out of the CRITICAL tier', () => {
        // CRITICAL should be rare and reviewable one row at a time. A read or
        // a routine create landing there is what makes the tier unreadable.
        for (const eventType of ['audit.read', 'product.create', 'content.unlock']) {
            expect(findAuditEventType(eventType)?.defaultSeverity).toBe(AuditSeverity.INFO);
        }
    });

    it('registers the events every alerting rule depends on', () => {
        // Each of these is named literally in docs/audit-logging.md §8.
        // An alert on an unregistered event type can never fire.
        for (const eventType of [
            'role.assign',
            'order.refund',
            'refund.process',
            'audit.export',
        ]) {
            expect(isKnownAuditEventType(eventType)).toBe(true);
        }
    });

    it('has at least one role.* event, so the role-probing alert can match', () => {
        const rolePrefixed = AUDIT_EVENT_CATALOG.filter((event) =>
            event.eventType.startsWith('role.'),
        );
        expect(rolePrefixed.length).toBeGreaterThan(0);
    });

    it('does not know an unregistered event', () => {
        expect(isKnownAuditEventType('totally.made.up')).toBe(false);
        expect(findAuditEventType('totally.made.up')).toBeUndefined();
    });
});
