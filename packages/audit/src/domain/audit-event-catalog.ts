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
    VENDOR: 'vendor',
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

const { BUYER, BRAND_EMPLOYEE, ARTIST, HITBOX_EMPLOYEE, HITBOX_ADMIN, SYSTEM } = AuditPersonaGroup;
const { INFO, WARNING, CRITICAL } = AuditSeverity;

/** Shorthand for the doc citations below. */
const AUTHZ = 'docs/authorization/authorization-architecture.md';
const AUDIT_DOC = 'docs/audit-logging.md';
const FINANCE_DOC = 'docs/finance/finance-revenue-ledger.md';
const ARTIST_ADMIN_DOC = 'docs/artist/artist-admin-api.md';

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
        sourceStories: [`${AUTHZ} 8`, `${AUTHZ} 12`],
    },
    {
        eventType: 'role.update',
        personaGroup: HITBOX_ADMIN,
        description: "A role's metadata or permission set changed, re-authorising every holder.",
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} 8`, `${AUTHZ} 12`],
    },
    {
        eventType: 'role.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'A role was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} 8`],
    },
    {
        eventType: 'role.assign',
        personaGroup: HITBOX_ADMIN,
        description: 'A role was granted to a user, at a scope.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} 5`, `${AUTHZ} 8`],
    },
    {
        eventType: 'role.revoke',
        personaGroup: HITBOX_ADMIN,
        description: "A user's role assignment was revoked.",
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUTHZ} 8`],
    },
    {
        eventType: 'permission.catalog.sync',
        personaGroup: SYSTEM,
        description:
            'The permission catalog was mirrored into the database, possibly retiring permissions.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUTHZ} 10`],
    },

    // ── The audit trail itself ──────────────────────────────────────────────
    {
        eventType: 'audit.read',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'The audit trail was queried. Recorded so reads are themselves reviewable.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} reading-the-trail`],
    },
    {
        eventType: 'audit.export',
        personaGroup: HITBOX_ADMIN,
        description:
            'The audit trail was exported in bulk. CRITICAL because it is the exfiltration signal.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} reading-the-trail`, `${AUDIT_DOC} alerting`],
    },
    {
        eventType: 'audit.retention-policy.update',
        personaGroup: HITBOX_ADMIN,
        description:
            'A retention window changed. Shortening one destroys evidence, so it is itself evidence.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} retention`],
    },

    // ── Organization lifecycle ──────────────────────────────────────────────
    {
        eventType: 'organization.create',
        personaGroup: HITBOX_ADMIN,
        description: 'A brand or seller organization was onboarded.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    {
        eventType: 'organization.update',
        personaGroup: BRAND_EMPLOYEE,
        description: 'Organization settings changed.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    {
        eventType: 'organization.suspend',
        personaGroup: HITBOX_ADMIN,
        description: 'An organization was suspended, cutting off everyone inside it.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    {
        eventType: 'organization.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'An organization was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },

    // ── Accounts ────────────────────────────────────────────────────────────
    {
        eventType: 'user.suspend',
        personaGroup: HITBOX_ADMIN,
        description: 'A user account was suspended.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    {
        eventType: 'user.delete',
        personaGroup: HITBOX_ADMIN,
        description: 'A user account was deleted or anonymised.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },

    // ── Artist collections ──────────────────────────────────────────────────
    // An artist curating their own series — docs/artist-collection/. Every
    // change is recorded so HitBox's monitoring view has a trail behind it.
    {
        eventType: 'artist.collection.create',
        personaGroup: ARTIST,
        description: 'An artist created a collection.',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.update',
        personaGroup: ARTIST,
        description: 'An artist edited a collection — name, address, description, visibility or hero image.',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.archive',
        personaGroup: ARTIST,
        description: 'An artist deleted (archived) a collection, taking it off the storefront.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.restore',
        personaGroup: ARTIST,
        description: 'An artist restored an archived collection.',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.reorder',
        personaGroup: ARTIST,
        description: 'An artist changed the order of their collections.',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.drops.add',
        personaGroup: ARTIST,
        description: 'An artist added their own drops to a collection (or moved them from another of theirs).',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },
    {
        eventType: 'artist.collection.drops.remove',
        personaGroup: ARTIST,
        description: 'An artist took a drop out of a collection.',
        defaultSeverity: INFO,
        sourceStories: ['docs/artist-collection/README.md'],
    },

    // ── Artist records, administered by HitBox staff ────────────────────────
    // Changing who appears on the storefront, and whether they can sell, is a
    // staff decision with a reason; switching an artist off or archiving them
    // is WARNING, as is anything touching the compliance attestation.
    {
        eventType: 'artist.profile.update',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff edited an artist's profile (name, handle, bio, genre, or took an image down).",
        defaultSeverity: INFO,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.compliance.attest',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff attested an artist's compliance.",
        defaultSeverity: WARNING,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.compliance.revoke',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff withdrew an artist's compliance attestation.",
        defaultSeverity: WARNING,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.activate',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff activated an artist.",
        defaultSeverity: INFO,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.deactivate',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff deactivated an artist — their profile is locked.",
        defaultSeverity: WARNING,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.archive',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff archived an artist.",
        defaultSeverity: WARNING,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.restore',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff restored an archived artist.",
        defaultSeverity: INFO,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.publish',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff listed an artist publicly on the storefront.",
        defaultSeverity: INFO,
        sourceStories: [ARTIST_ADMIN_DOC],
    },
    {
        eventType: 'artist.profile.unlist',
        personaGroup: HITBOX_ADMIN,
        description: "HitBox staff took an artist off the public storefront.",
        defaultSeverity: INFO,
        sourceStories: [ARTIST_ADMIN_DOC],
    },

    // ── Orders ──────────────────────────────────────────────────────────────
    // What a person does to an order. System-driven changes (webhook, sweep,
    // NFC tap) are on the order's own status history instead.
    {
        eventType: 'order.status.change',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'An operator changed an order’s status (processing, delivered, cancelled).',
        defaultSeverity: WARNING,
        sourceStories: ['docs/orders/order-history-and-shipments.md'],
    },
    {
        eventType: 'order.shipment.record',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'An operator recorded or corrected an order’s carrier and tracking number.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/orders/order-history-and-shipments.md'],
    },

    // ── Money ───────────────────────────────────────────────────────────────
    {
        eventType: 'order.refund',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A refund was approved on an order.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} alerting`],
    },
    {
        eventType: 'refund.process',
        personaGroup: SYSTEM,
        description:
            'A refund was executed against the payment provider, for reconciliation against it.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} alerting`],
    },
    {
        eventType: 'payment.gateway.configure',
        personaGroup: HITBOX_ADMIN,
        description: 'Payment gateway configuration changed.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    {
        eventType: 'royalty.override',
        personaGroup: HITBOX_ADMIN,
        description: 'A royalty posting was overridden outside the normal calculation.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} write-paths`],
    },
    // ── Finance & revenue ledger ────────────────────────────────────────────
    // Every write path in @hitbox/finance and @hitbox/payments lands here.
    // The accrual is INFO because it happens on every claim and is valuable in
    // aggregate rather than individually; everything that MOVES money, changes
    // what someone is owed, or changes where money lands is CRITICAL.
    {
        eventType: 'payment.settle',
        personaGroup: SYSTEM,
        description: 'A charge settled and its order was marked paid.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} payment-flow`],
    },
    {
        eventType: 'royalty.accrue',
        personaGroup: SYSTEM,
        description: 'A royalty was accrued against a claim.',
        defaultSeverity: INFO,
        sourceStories: [`${FINANCE_DOC} royalty-lifecycle`],
    },
    {
        eventType: 'royalty.rule.change',
        personaGroup: HITBOX_ADMIN,
        description: 'A royalty rule was created or closed.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} royalty-rules`],
    },
    {
        eventType: 'royalty.payout.schedule',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'Accrued royalties were batched into a payout.',
        defaultSeverity: WARNING,
        sourceStories: [`${FINANCE_DOC} payouts`],
    },
    {
        eventType: 'royalty.payout.execute',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A royalty payout was approved, paid, or failed.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} payouts`],
    },
    {
        eventType: 'adjustment.create',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A correction was posted against a financial record.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} immutability`],
    },
    {
        eventType: 'dispute.open',
        personaGroup: SYSTEM,
        description: 'A chargeback or payment dispute was opened.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} disputes`],
    },
    {
        eventType: 'dispute.resolve',
        personaGroup: HITBOX_EMPLOYEE,
        description: 'A dispute was resolved, or evidence was submitted for it.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${FINANCE_DOC} disputes`],
    },

    // ── Catalog ─────────────────────────────────────────────────────────────
    {
        eventType: 'product.create',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was created.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'product.update',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was edited.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'product.delete',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A product was deleted.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'release.submit',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A drop was submitted for release review, opening a new version.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'release.approve',
        // Regrouped from hitbox_employee: a release is now approved by the
        // party that owns the drop — the artist or the brand — and a HitBox
        // administrator explicitly cannot approve on their behalf.
        personaGroup: BRAND_EMPLOYEE,
        description:
            'A release was approved for publication by its owner, with the legal ' +
            'compliance statement accepted. A DENIED record means someone who was ' +
            'not the owner attempted it.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'release.reject',
        personaGroup: BRAND_EMPLOYEE,
        description: 'A release was rejected, with the reason in metadata.note.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'release.amend',
        personaGroup: BRAND_EMPLOYEE,
        description: "A reviewer edited an undecided release's compliance notes.",
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },
    {
        eventType: 'release.reopen',
        personaGroup: HITBOX_ADMIN,
        description:
            'An administrator sent a decided release back to its owner for another ' +
            'decision. Records the reason, and never itself approves anything.',
        defaultSeverity: WARNING,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
    },

    // ── Provenance — the events that carry a ledgerReferenceId ──────────────
    {
        eventType: 'nfc-tag.claim',
        personaGroup: BUYER,
        description:
            'A collectible was claimed by tapping its tag. Writes provenance to the ledger.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} the-event-itself`, `${AUDIT_DOC} alerting`],
    },
    {
        eventType: 'ownership.transfer',
        personaGroup: BUYER,
        description: 'Ownership of a collectible moved between accounts.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} the-event-itself`, `${AUDIT_DOC} alerting`],
    },
    {
        eventType: 'claim.revoke',
        personaGroup: HITBOX_ADMIN,
        description: 'A claim was revoked and its tag flagged, e.g. on a counterfeit report.',
        defaultSeverity: CRITICAL,
        sourceStories: [`${AUDIT_DOC} the-event-itself`],
    },

    // ── Serialized inventory ────────────────────────────────────────────────
    // CRITICAL rather than WARNING because of what is reachable through these
    // two keys: a tag marked REVOKED stops an owner verifying an object they
    // are holding, and a unit archived or resale-blocked stops it moving. They
    // are rare, they are deliberate, and each one is a question somebody will
    // ask again later.
    {
        eventType: 'sku.update',
        personaGroup: HITBOX_ADMIN,
        description:
            "A serialized unit's record was edited — trust flags, tag lifecycle state, " +
            'listing or archival state. Carries before/after for the changed columns only.',
        defaultSeverity: CRITICAL,
        sourceStories: ['docs/admin/sku-inventory-management.md 3'],
    },
    {
        eventType: 'sku.batch-update',
        personaGroup: HITBOX_ADMIN,
        description:
            'The same edit was applied to many serialized units in one transaction. ' +
            'Carries the change and the list of units, not per-unit snapshots.',
        defaultSeverity: CRITICAL,
        sourceStories: ['docs/admin/sku-inventory-management.md 4'],
    },

    // ── Publication ─────────────────────────────────────────────────────────
    {
        eventType: 'product.publish',
        personaGroup: HITBOX_ADMIN,
        description:
            'A drop was taken live, or an attempt to take it live was refused. Carries ' +
            'the review it cleared (id, version, authority) so "who authorised this" is ' +
            'answerable from the trail alone. DENIED rows record an attempt to publish ' +
            'a drop whose owner had not approved it.',
        // CRITICAL because this is the moment a drop becomes purchasable by the
        // public, and because a DENIED row here is an attempt to bypass the
        // owner's approval — the single thing the release authority rule exists
        // to prevent.
        defaultSeverity: CRITICAL,
        sourceStories: ['docs/admin/drop-approval-lifecycle.md §10'],
    },
    {
        eventType: 'product.reward-points.set',
        personaGroup: HITBOX_ADMIN,
        description:
            'A HitBox System Admin set the reward points on a drop. Before/after carry ' +
            'the old and new value; metadata.reason the why, when given.',
        // WARNING: points are value handed to buyers, and only one role may set
        // them — a change is worth seeing in a review, not just in the row.
        defaultSeverity: WARNING,
        sourceStories: ['docs/admin/drop-reward-points.md'],
    },

    // ── Supply intake ───────────────────────────────────────────────────────
    // Chain of custody. Taking delivery of 5,000 chips is the moment the
    // platform becomes accountable for them, so the whole intake path is
    // recorded rather than merely logged.
    //
    // The two chip events are CRITICAL and the three administrative ones are
    // WARNING, and the line is drawn at anti-counterfeiting material: a chip
    // registered into inventory is a UID that can never be registered again,
    // and a QC verdict is what decides whether it may be bound to an item at
    // all. Booking a carton in is consequential but reversible by a correcting
    // consignment; a UID is not.
    {
        eventType: 'supply.vendor.create',
        personaGroup: HITBOX_ADMIN,
        description:
            'A manufacturer or supplier was registered. Carries the name, type and country.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/admin/supply-inventory-api.md 5'],
    },
    {
        eventType: 'supply.vendor.update',
        personaGroup: HITBOX_ADMIN,
        description:
            "A vendor's record was edited or archived. Carries the field names that " +
            'changed, never their values — contact details are the vendor\'s PII.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/admin/supply-inventory-api.md 5'],
    },
    {
        eventType: 'supply.batch.create',
        personaGroup: HITBOX_ADMIN,
        description:
            'A consignment was booked in. Carries the vendor, item type, declared ' +
            'quantity and the vendor\'s own batch reference.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/admin/supply-inventory-api.md 6'],
    },
    {
        eventType: 'supply.batch.decide',
        personaGroup: HITBOX_ADMIN,
        description:
            'A consignment was validated, accepted or rejected. Carries before/after ' +
            'status and the decision note. Rejection becomes a credit note, so the ' +
            'note is the part that cannot be reconstructed later.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/admin/supply-inventory-api.md 6'],
    },
    {
        eventType: 'supply.tags.register',
        personaGroup: HITBOX_ADMIN,
        description:
            'A vendor chip manifest was registered into a consignment. Carries the row ' +
            'count and the key reference — NEVER tag UIDs, which would make the audit ' +
            'trail a second and longer-lived copy of the anti-counterfeiting material.',
        defaultSeverity: CRITICAL,
        sourceStories: ['docs/admin/supply-inventory-api.md 7'],
    },
    {
        eventType: 'supply.tag.qc',
        personaGroup: HITBOX_ADMIN,
        description:
            'A quality-control verdict was recorded against one chip. Carries ' +
            'before/after QC status.',
        defaultSeverity: CRITICAL,
        sourceStories: ['docs/admin/supply-inventory-api.md 8'],
    },
    // Vendor portal administration. Inviting someone to a vendor grants them a
    // role, and assigning a drop decides which goods they may book in — both
    // are access decisions, so WARNING like the rest of supply administration.
    // Vendor-portal writes themselves reuse supply.batch.create and
    // supply.tags.register, recorded with actor type VENDOR.
    {
        eventType: 'supply.vendor.member.invite',
        personaGroup: HITBOX_ADMIN,
        description:
            'Someone was invited to sign in to the vendor portal for a vendor. Carries ' +
            'the vendor, the invitation id and whether the role was granted immediately.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/vendor/vendor-admin-api.md'],
    },
    {
        eventType: 'supply.vendor.member.revoke',
        personaGroup: HITBOX_ADMIN,
        description:
            "A vendor portal member's access was revoked. Carries the before/after " +
            'status and the reason.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/vendor/vendor-admin-api.md'],
    },
    {
        eventType: 'supply.vendor.drop.assign',
        personaGroup: HITBOX_ADMIN,
        description: 'A vendor was allowed to supply a drop through the vendor portal.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/vendor/vendor-admin-api.md'],
    },
    {
        eventType: 'supply.vendor.drop.allotment',
        personaGroup: HITBOX_ADMIN,
        description:
            "A vendor's allotment for a drop was changed — per variant, or the drop-level " +
            'quantity. Carries before/after allotments.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/vendor/vendor-admin-api.md'],
    },
    {
        eventType: 'supply.vendor.drop.unassign',
        personaGroup: HITBOX_ADMIN,
        description:
            'A vendor was withdrawn from supplying a drop. Consignments already booked ' +
            'are untouched.',
        defaultSeverity: WARNING,
        sourceStories: ['docs/vendor/vendor-admin-api.md'],
    },

    // ── Content ─────────────────────────────────────────────────────────────
    {
        eventType: 'content.unlock',
        personaGroup: BUYER,
        description: 'A buyer unlocked exclusive content.',
        defaultSeverity: INFO,
        sourceStories: [`${AUDIT_DOC} what-is-recorded`],
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
