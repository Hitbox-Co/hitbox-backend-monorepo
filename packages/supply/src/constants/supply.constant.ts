export const SUPPLY_MODULE = 'supply' as const;

export const SUPPLY_ERROR_CODES = {
    NOT_FOUND: 'SUPPLY_NOT_FOUND',
    VENDOR_NOT_FOUND: 'SUPPLY_VENDOR_NOT_FOUND',
    BATCH_NOT_FOUND: 'SUPPLY_BATCH_NOT_FOUND',
    TAG_NOT_FOUND: 'SUPPLY_TAG_NOT_FOUND',
    FORBIDDEN: 'SUPPLY_FORBIDDEN',
    /** Refused: a tag UID in the manifest is already registered. */
    TAG_UID_TAKEN: 'SUPPLY_TAG_UID_TAKEN',
    /** Refused: the manifest repeats a UID within its own rows. */
    TAG_UID_DUPLICATED: 'SUPPLY_TAG_UID_DUPLICATED',
    /** Refused: the transition is not legal from the batch's current status. */
    BATCH_STATE_INVALID: 'SUPPLY_BATCH_STATE_INVALID',
    /** Refused: registering these rows would exceed the batch's declared quantity. */
    BATCH_QUANTITY_EXCEEDED: 'SUPPLY_BATCH_QUANTITY_EXCEEDED',
    /** Refused: tags may only be registered into an NFC_TAG batch. */
    BATCH_ITEM_TYPE_INVALID: 'SUPPLY_BATCH_ITEM_TYPE_INVALID',
    /** Refused: the vendor is archived, so it cannot take new consignments. */
    VENDOR_ARCHIVED: 'SUPPLY_VENDOR_ARCHIVED',
    /** Refused: an update body that would change nothing. */
    NO_CHANGES: 'SUPPLY_NO_CHANGES',
    /** Refused: a rejection with no note. */
    NOTE_REQUIRED: 'SUPPLY_NOTE_REQUIRED',
} as const;

/**
 * Reading vendors and consignments.
 *
 * `drop:read` rather than `nfc-tag-claim:read`, matching the gate the
 * dashboard's own `supply` section already uses. A consignment header — who
 * shipped it, when, how many, against which drop — is planning data for
 * whoever runs the drop, and `HITBOX_DROP_MANAGER` holds no `nfc-tag-claim`
 * grant at all.
 *
 * What makes that safe is the payload boundary: this capability reaches batch
 * *headers*. Individual chips are a different surface with a different gate —
 * see SUPPLY_TAG_READ_CAPABILITY.
 */
export const SUPPLY_READ_CAPABILITY = 'drop:read' as const;

/**
 * Reading the chip inventory itself.
 *
 * Strictly more sensitive than a batch header: a tag row carries the UID hash,
 * the QC verdict and the lifecycle state, which together are what a
 * counterfeiter would need to know which chips exist and which are still
 * unbound. `HITBOX_SUPPORT` and `HITBOX_ORDER_MANAGER` hold this and no write
 * capability, which is the shape their jobs actually need.
 *
 * The UID hash and the encrypted UID are never selected into a response under
 * any capability — see repository/supply.repository.ts.
 */
export const SUPPLY_TAG_READ_CAPABILITY = 'nfc-tag-claim:read' as const;

/**
 * Recording intake: vendors, consignments, manifests, QC verdicts.
 *
 * Mounted `globalOnly`. Supply intake is a platform custody function — a brand
 * does not take delivery of the platform's chip stock, and an organization
 * -scoped grant on this route would let one brand register chips against
 * another's consignment. Reads stay organization-scoped; writes do not.
 */
export const SUPPLY_WRITE_CAPABILITY = 'nfc-tag-claim:manage' as const;

/**
 * The metrics rollup.
 *
 * Gated on reporting rather than on the underlying resources, because that is
 * what it is: aggregate counts with no row-level detail. The *tag funnel*
 * block inside the response additionally requires SUPPLY_TAG_READ_CAPABILITY,
 * so a Finance Admin reading supply metrics gets consignment and stock figures
 * with the chip lifecycle breakdown absent — absent, not zeroed.
 */
export const SUPPLY_METRICS_CAPABILITY = 'reports-dashboards:read' as const;

export const SUPPLY_DEFAULT_LIMIT = 50;
export const SUPPLY_MAX_LIMIT = 200;

/**
 * Rows one manifest call may register.
 *
 * Matched to a physical carton of chips, and registered in one transaction so
 * a half-applied manifest is never a state someone has to reconcile against a
 * box by hand. A 10,000-chip consignment arrives as ten calls.
 */
export const SUPPLY_MANIFEST_MAX = 1000;

/** Drops whose remaining stock falls below this share are reported as low. */
export const LOW_STOCK_THRESHOLD = 0.1;

/** Rows in the `lowStock` and `vendors.leaders` metric lists. */
export const SUPPLY_METRIC_LIST_SIZE = 10;

export const SUPPLY_EVENTS = {
    VENDOR_CREATED: 'supply.vendor.created',
    VENDOR_UPDATED: 'supply.vendor.updated',
    BATCH_CREATED: 'supply.batch.created',
    /** A consignment was accepted or rejected. Payload carries counts, not rows. */
    BATCH_DECIDED: 'supply.batch.decided',
    /** A manifest committed. Payload carries counts, never UIDs. */
    TAGS_REGISTERED: 'supply.tags.registered',
    TAG_QC_RECORDED: 'supply.tag.qc-recorded',
} as const;

/**
 * Audit event keys, registered in the audit module's catalog.
 *
 * Intake is a chain-of-custody record: taking delivery of 5,000 chips is the
 * moment the platform becomes accountable for them, so every one of these
 * writes is recorded rather than merely logged.
 */
export const SUPPLY_AUDIT_EVENTS = {
    VENDOR_CREATE: 'supply.vendor.create',
    VENDOR_UPDATE: 'supply.vendor.update',
    BATCH_CREATE: 'supply.batch.create',
    BATCH_DECIDE: 'supply.batch.decide',
    TAGS_REGISTER: 'supply.tags.register',
    TAG_QC: 'supply.tag.qc',
} as const;
