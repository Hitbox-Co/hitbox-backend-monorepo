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
    /** Refused: this consignment's category carries no chips. */
    BATCH_ITEM_TYPE_INVALID: 'SUPPLY_BATCH_ITEM_TYPE_INVALID',
    /** Refused: the vendor is archived, so it cannot take new consignments. */
    VENDOR_ARCHIVED: 'SUPPLY_VENDOR_ARCHIVED',
    /** Refused: an update body that would change nothing. */
    NO_CHANGES: 'SUPPLY_NO_CHANGES',
    /** Refused: a rejection with no note. */
    NOTE_REQUIRED: 'SUPPLY_NOTE_REQUIRED',

    // ── Vendor portal ───────────────────────────────────────────────────────
    /** The caller's account is not an active member of any vendor. */
    VENDOR_MEMBERSHIP_REQUIRED: 'SUPPLY_VENDOR_MEMBERSHIP_REQUIRED',
    VENDOR_MEMBER_NOT_FOUND: 'SUPPLY_VENDOR_MEMBER_NOT_FOUND',
    /** Refused: the address already has an open or active membership. */
    VENDOR_MEMBER_EXISTS: 'SUPPLY_VENDOR_MEMBER_EXISTS',
    /** Refused: the account already belongs to a different vendor. */
    VENDOR_MEMBER_OTHER_VENDOR: 'SUPPLY_VENDOR_MEMBER_OTHER_VENDOR',
    /** Refused: the vendor is inactive, so its portal is closed. */
    VENDOR_INACTIVE: 'SUPPLY_VENDOR_INACTIVE',
    /** Refused: no invitable email — none in the body and no contactEmail on file. */
    VENDOR_EMAIL_REQUIRED: 'SUPPLY_VENDOR_EMAIL_REQUIRED',
    /** Refused: the vendor is not assigned to this drop. */
    DROP_NOT_ASSIGNED: 'SUPPLY_DROP_NOT_ASSIGNED',
    DROP_ALREADY_ASSIGNED: 'SUPPLY_DROP_ALREADY_ASSIGNED',
    // ── Variants ────────────────────────────────────────────────────────────
    /** A variant id that is not a live variant of the drop. */
    VARIANT_INVALID: 'SUPPLY_VARIANT_INVALID',
    /** A consignment split by variant got a manifest row with no variantId. */
    VARIANT_REQUIRED: 'SUPPLY_VARIANT_REQUIRED',
    /** A manifest row names a variant the consignment has no line for. */
    VARIANT_NOT_IN_BATCH: 'SUPPLY_VARIANT_NOT_IN_BATCH',
    /** A manifest would put more chips on a variant than its line declares. */
    LINE_QUANTITY_EXCEEDED: 'SUPPLY_LINE_QUANTITY_EXCEEDED',
    /** A drop with variants must be allotted by variant (and vice versa). */
    ALLOTMENT_SHAPE_INVALID: 'SUPPLY_ALLOTMENT_SHAPE_INVALID',
    /** Accept refused: not every declared unit has a registered chip yet. */
    MANIFEST_INCOMPLETE: 'SUPPLY_MANIFEST_INCOMPLETE',
    /** Vendor chip upload refused: HitBox has not validated the consignment yet. */
    BATCH_NOT_VALIDATED: 'SUPPLY_BATCH_NOT_VALIDATED',
    /** Accept kept colliding with concurrent minting on the same drop. */
    ACCEPT_CONFLICT: 'SUPPLY_ACCEPT_CONFLICT',
    /** Accept refused: the consignment's drop no longer exists. */
    DROP_NOT_FOUND: 'SUPPLY_DROP_NOT_FOUND',
    /** Accept refused: the vendor's allotment does not cover this consignment. */
    ALLOTMENT_INSUFFICIENT: 'SUPPLY_ALLOTMENT_INSUFFICIENT',
    /** An allotment edit would drop below what HitBox has already accepted. */
    ALLOTMENT_BELOW_ACCEPTED: 'SUPPLY_ALLOTMENT_BELOW_ACCEPTED',
    /** No identity provider / VENDOR role configured — invitations unavailable. */
    VENDOR_INVITATIONS_UNAVAILABLE: 'SUPPLY_VENDOR_INVITATIONS_UNAVAILABLE',
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

/**
 * The vendor portal (`/api/v1/vendor`). Checked at `own` scope against the
 * caller's own id, so only a holder of `vendor-supply:*:own` — the VENDOR role
 * — passes. Which vendor and which drops are then resolved from the caller's
 * VendorMember row and its VendorDropAssignments, never from the request.
 */
export const VENDOR_PORTAL_READ_CAPABILITY = 'vendor-supply:read' as const;
export const VENDOR_PORTAL_WRITE_CAPABILITY = 'vendor-supply:create' as const;

/** The role a vendor invitation grants. */
export const VENDOR_ROLE_NAME = 'VENDOR' as const;

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
    VENDOR_MEMBER_INVITED: 'supply.vendor.member-invited',
    VENDOR_MEMBER_ACTIVATED: 'supply.vendor.member-activated',
    VENDOR_MEMBER_REVOKED: 'supply.vendor.member-revoked',
    VENDOR_DROP_ASSIGNED: 'supply.vendor.drop-assigned',
    VENDOR_DROP_UNASSIGNED: 'supply.vendor.drop-unassigned',
    VENDOR_ALLOTMENT_UPDATED: 'supply.vendor.allotment-updated',
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
    VENDOR_MEMBER_INVITE: 'supply.vendor.member.invite',
    VENDOR_MEMBER_REVOKE: 'supply.vendor.member.revoke',
    VENDOR_DROP_ASSIGN: 'supply.vendor.drop.assign',
    VENDOR_DROP_UNASSIGN: 'supply.vendor.drop.unassign',
    VENDOR_DROP_ALLOTMENT: 'supply.vendor.drop.allotment',
} as const;
