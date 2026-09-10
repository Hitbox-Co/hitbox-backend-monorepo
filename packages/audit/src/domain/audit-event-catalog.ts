import { AuditSeverity } from '@hitbox/database';

/**
 * THE AUDIT EVENT CATALOG — the code-side authority over which events exist.
 *
 * `AuditEventType` is a table rather than an enum precisely so an event can be
 * registered without a migration, and this file is not a second gate on that:
 * it is the *seed source* and the fast path. `seedAudit` mirrors these rows
 * into the table, and the recorder resolves a severity from here without a
 * round trip. An operator who inserts a row directly still works — the
 * recorder falls back to reading the table for any key it does not know — they
 * just do not get the compile-time key.
 *
 * Registering an event here is what makes it auditable. No controller decides
 * whether something is "sensitive"; it calls `record('order.refund', …)` and
 * the severity on this row is what makes it CRITICAL, once, in one place.
 */

/**
 * Which actor family an event belongs to. Mirrors `AuditActorType`, but as a
 * grouping label for admin UIs rather than a claim about who may perform it —
 * `product.delete` is grouped under brand_employee because that is who does it
 * day to day, and a HitBox admin doing it is still the same event.
 */
export const AuditPersonaGroup = {
    BUYER: 'buyer',
    BRAND_EMPLOYEE: 'brand_employee',
    ARTIST: 'artist',
    HITBOX_EMPLOYEE: 'hitbox_employee',
    HITBOX_ADMIN: 'hitbox_admin',
    SYSTEM: 'system',
} as const;
export type AuditPersonaGroup = (typeof AuditPersonaGroup)[keyof typeof AuditPersonaGroup];

export interface AuditEventTypeDefinition {
    eventType: string;
    personaGroup: AuditPersonaGroup;
    description: string;
    defaultSeverity: AuditSeverity;
    /**
     * What justified this event existing, so the catalog is defensible in a
     * review. These currently cite the architecture docs; replace a citation
     * with the story id once the requirement it came from has one — but do not
     * leave an event uncited, because "why do we log this?" is the first
     * question a compliance review asks.
     */
    sourceStories: string[];
}

const { BUYER, BRAND_EMPLOYEE, HITBOX_EMPLOYEE, HITBOX_ADMIN, SYSTEM } = AuditPersonaGroup;
const { INFO, WARNING, CRITICAL } = AuditSeverity;

/** Shorthand for the doc citations below. */
const AUTHZ = 'docs/authorization/authorization-architecture.md';
const AUDIT_DOC = 'docs/audit-logging.md';

export const AUDIT_EVENT_CATALOG: readonly AuditEventTypeDefinition[] = [
    // ── Role administration ─────────────────────────────────────────────────
    // All CRITICAL: these change what an unknown set of people may do, they
    // happen rarely, and a grant nobody can account for is the thing an
    // incident review exists to find.
    {
        eventType: 'role.create',
        personaGroup: HITBOX_ADMIN,
        description: 'A role was defined, with its initial permission set.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} §8`, `${AUTHZ} §12`],
    },
    {
        eventType: 'role.update',
        personaGroup: HITBOX_ADMIN,
        description: "A role's metadata or permission set changed, re-authorising every holder.",
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} §8`, `${AUTHZ} §12`],
    },
    {
        eventType: 'role.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'A role was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} §8`],
    },
    {
        eventType: 'role.assign',
        personaGroup: HITBOX_ADMIN,
        description: 'A role was granted to a user, at a scope.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} §5`, `${AUTHZ} §8`],
    },
    {
        eventType: 'role.revoke',
        personaGroup: HITBOX_ADMIN,
        description: "A user's role assignment was revoked.",
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} §8`],
    },
    {
        eventType: 'permission.catalog.sync',
        personaGroup: SYSTEM,
        description:
            'The permission catalog was mirrored into the database, possibly retiring permissions.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUTHZ} §10`],
    },

    // ── The audit trail itself ──────────────────────────────────────────────
    {
        eventType: 'audit.read',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'The audit trail was queried. Recorded so reads are themselves reviewable.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} §reading-the-trail`],
    },
    {
        eventType: 'audit.export',
        personaGroup: HITBOX_ADMIN,
        description:
            'The audit trail was exported in bulk. CRITICAL because it is the exfiltration signal.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §reading-the-trail`, `${AUDIT_DOC} §alerting`],
    },
    {
        eventType: 'audit.retention-policy.update',
        personaGroup: HITBOX_ADMIN,
        description:
            'A retention window changed. Shortening one destroys evidence, so it is itself evidence.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §retention`],
    },

    // ── Organization lifecycle ──────────────────────────────────────────────
    {
        eventType: 'organization.create',
        personaGroup: HITBOX_ADMIN,
        description: 'A brand or seller organization was onboarded.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },
    {
        eventType: 'organization.update',
        personaGroup: BRAND_EMPLOYEE,
        description: 'Organization settings changed.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },
    {
        eventType: 'organization.suspend',
        personaGroup: HITBOX_ADMIN,
        description: 'An organization was suspended, cutting off everyone inside it.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },
    {
        eventType: 'organization.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'An organization was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },

    // ── Accounts ────────────────────────────────────────────────────────────
    {
        eventType: 'user.suspend',
        personaGroup: HITBOX_ADMIN,
        description: 'A user account was suspended.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },
    {
        eventType: 'user.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'A user account was deleted or anonymised.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },

    // ── Money ───────────────────────────────────────────────────────────────
    {
        eventType: 'order.refund',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A refund was approved on an order.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §alerting`],
    },
    {
        eventType: 'refund.process',
        personaGroup: SYSTEM,
        description:
            'A refund was executed against the payment provider, for reconciliation against it.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §alerting`],
    },
    {
        eventType: 'payment.gateway.configure',
        personaGroup: HITBOX_ADMIN,
        description: 'Payment gateway configuration changed.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },
    {
        eventType: 'royalty.override',
        personaGroup: HITBOX_ADMIN,
        description: 'A royalty posting was overridden outside the normal calculation.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §write-paths`],
    },

    // ── Catalog ─────────────────────────────────────────────────────────────
    {
        eventType: 'product.create',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was created.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },
    {
        eventType: 'product.update',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was edited.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },
    {
        eventType: 'product.delete',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },
    {
        eventType: 'release.approve',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A release was approved for publication.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },
    {
        eventType: 'release.reject',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A release was rejected.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },

    // ── Provenance — the events that carry a ledgerReferenceId ──────────────
    {
        eventType: 'nfc-tag.claim',
        personaGroup: BUYER,
        description:
            'A collectible was claimed by tapping its tag. Writes provenance to the ledger.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §the-event-itself`, `${AUDIT_DOC} §alerting`],
    },
    {
        eventType: 'ownership.transfer',
        personaGroup: BUYER,
        description: 'Ownership of a collectible moved between accounts.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §the-event-itself`, `${AUDIT_DOC} §alerting`],
    },
    {
        eventType: 'claim.revoke',
        personaGroup: HITBOX_ADMIN,
        description: 'A claim was revoked and its tag flagged, e.g. on a counterfeit report.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} §the-event-itself`],
    },

    // ── Content ─────────────────────────────────────────────────────────────
    {
        eventType: 'content.unlock',
        personaGroup: BUYER,
        description: 'A buyer unlocked exclusive content.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} §what-is-recorded`],
    },
];

/**
 * Index built at import time, asserted unique and cited on the way through.
 * Two rows with the same key would mean the second silently shadowed the
 * first, and a shadowed severity is exactly the drift this catalog exists to
 * prevent — so it is a boot failure, not a surprise in production.
 */
export const AUDIT_EVENT_TYPES: ReadonlyMap<string, AuditEventTypeDefinition> = (() => {
    const map = new Map<string, AuditEventTypeDefinition>();
    for (const definition of AUDIT_EVENT_CATALOG) {
        if (map.has(definition.eventType)) {
            throw new Error(
                `Duplicate audit event type "${definition.eventType}" in AUDIT_EVENT_CATALOG.`,
            );
        }
        if (definition.sourceStories.length === 0) {
            throw new Error(
                `Audit event type "${definition.eventType}" has no sourceStories. ` +
                    'Every event must cite the requirement that justified it.',
            );
        }
        map.set(definition.eventType, definition);
    }
    return map;
})();

/** Every key in the catalog, so a call site can be typed against it. */
export type KnownAuditEventType = (typeof AUDIT_EVENT_CATALOG)[number]['eventType'];

export function findAuditEventType(eventType: string): AuditEventTypeDefinition | undefined {
    return AUDIT_EVENT_TYPES.get(eventType);
}

export function isKnownAuditEventType(eventType: string): boolean {
    return AUDIT_EVENT_TYPES.has(eventType);
}
