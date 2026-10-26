/**
 * The compliance trail for supply intake, as a port.
 *
 * Taking delivery of 5,000 chips is the moment the platform becomes
 * accountable for them, so intake is recorded rather than merely logged. The
 * port speaks plain records — no Prisma types cross it — so this module never
 * imports the audit module or its JSON types.
 */
/** Who performed a supply write: HitBox staff, or a vendor through the portal. */
export type SupplyActorType = 'HITBOX_ADMIN' | 'VENDOR';

export interface SupplyAuditInput {
    eventType: string;
    actorId: string;
    /** Defaults to HITBOX_ADMIN — every route but the vendor portal is staff-only. */
    actorType?: SupplyActorType | undefined;
    organizationId: string | null;
    /** The row the event is about: a vendor, a batch or a tag. */
    resourceType: 'Vendor' | 'VendorMember' | 'VendorDropAssignment' | 'SupplyBatch' | 'NfcTag';
    resourceId: string | null;
    result: 'SUCCESS' | 'DENIED';
    correlationId: string;
    before?: Record<string, unknown> | undefined;
    after?: Record<string, unknown> | undefined;
    metadata?: Record<string, unknown> | undefined;
}

export interface ISupplyAudit {
    /**
     * Awaited, and allowed to throw. An intake write whose audit row failed is
     * an intake write nobody can reconcile against the physical carton, so the
     * request fails with it rather than succeeding quietly.
     */
    record(input: SupplyAuditInput): Promise<void>;
}

/**
 * Stand-in for a test harness. A server must pass the real recorder, or a
 * consignment is accepted with nothing to show for it.
 */
export const NOOP_SUPPLY_AUDIT: ISupplyAudit = {
    record: async () => { },
};
