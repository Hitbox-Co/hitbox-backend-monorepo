import {
    QcStatus,
    SupplyBatchStatus,
    SupplyItemType,
    TagLifecycleState,
    VendorMemberStatus,
    VendorType,
} from '@hitbox/database';
import { z } from 'zod';
import {
    SUPPLY_DEFAULT_LIMIT,
    SUPPLY_MANIFEST_MAX,
    SUPPLY_MAX_LIMIT,
} from '../constants/supply.constant';

// ────────────────────────────────────────────────────────────────────────────
// Shared field helpers
//
// Query strings arrive as strings and multipart form posts arrive as strings
// too, so enums are accepted case-insensitively and booleans are coerced. The
// alternative is a 422 for `?status=accepted`, which is a wire-format argument
// dressed up as a validation failure.
// ────────────────────────────────────────────────────────────────────────────

const upperEnum = <T extends Record<string, string>>(e: T) =>
    z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(z.nativeEnum(e));

const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        // An empty string from a cleared form field means "no value", not "the
        // empty string" — storing `''` would make `notes IS NULL` lie.
        .transform((value) => (value.length === 0 ? undefined : value))
        .optional();

/**
 * An optional field that a cleared form control may send as `''`.
 *
 * Without this, `contactEmail: ""` from a form whose email box was emptied is a
 * 422 complaining the value is not an email — which is true and useless, since
 * the caller was saying "there is no email". The empty string becomes
 * `undefined` *before* the inner check runs, so the check only ever sees a
 * value somebody actually typed.
 */
const optionalWhenBlank = <T extends z.ZodTypeAny>(inner: T) =>
    z
        .union([z.string(), inner])
        .optional()
        .transform((value) =>
            typeof value === 'string' && value.trim().length === 0 ? undefined : value,
        )
        .pipe(inner.optional());

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(SUPPLY_MAX_LIMIT)
        .default(SUPPLY_DEFAULT_LIMIT),
};

/** ISO date or datetime; stored as a Date. */
const isoDate = z.coerce.date();

// ────────────────────────────────────────────────────────────────────────────
// Vendors
// ────────────────────────────────────────────────────────────────────────────

export const listVendorsQuerySchema = z.object({
    /** Matches name or legal name, case-insensitively. */
    search: z.string().trim().min(1).max(100).optional(),
    vendorType: upperEnum(VendorType).optional(),
    /** ISO 3166-1 alpha-2. */
    country: z.string().trim().length(2).toUpperCase().optional(),
    isActive: z.coerce.boolean().optional(),
    includeArchived: z.coerce.boolean().default(false),
    ...pagination,
});
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>;

export const createVendorSchema = z.object({
    name: z.string().trim().min(1).max(200),
    legalName: optionalText(200),
    /** ISO 3166-1 alpha-2 — a consignment crossing a border is a customs question. */
    country: optionalWhenBlank(z.string().trim().length(2).toUpperCase()),
    vendorType: upperEnum(VendorType),
    contactName: optionalText(200),
    contactEmail: optionalWhenBlank(z.string().trim().email().max(320)),
    contactPhone: optionalText(50),
    notes: optionalText(2000),
    isActive: z.coerce.boolean().default(true),
});
export type CreateVendorDto = z.infer<typeof createVendorSchema>;

/**
 * Every field optional, but at least one required — a PATCH that changes
 * nothing is a mistake on the caller's side, not a no-op worth a 200.
 *
 * `archived` is the soft-retire switch rather than a DELETE: a vendor with
 * consignments against it cannot be removed without removing the record that
 * those consignments arrived.
 */
export const updateVendorSchema = createVendorSchema
    .partial()
    .extend({ archived: z.coerce.boolean().optional() })
    .refine((value) => Object.keys(value).length > 0, {
        message: 'Provide at least one field to update.',
    });
export type UpdateVendorDto = z.infer<typeof updateVendorSchema>;

export interface VendorResponse {
    id: string;
    name: string;
    legalName: string | null;
    country: string | null;
    vendorType: VendorType;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
    isActive: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
    /** Live counts — useful for "safe to retire?" and for sorting a picker. */
    counts: { batches: number; units: number };
}

// ────────────────────────────────────────────────────────────────────────────
// Consignments
// ────────────────────────────────────────────────────────────────────────────

export const listBatchesQuerySchema = z.object({
    vendorId: z.string().uuid().optional(),
    dropId: z.string().uuid().optional(),
    status: upperEnum(SupplyBatchStatus).optional(),
    itemType: upperEnum(SupplyItemType).optional(),
    /** Matches the vendor's own batch label or invoice reference. */
    search: z.string().trim().min(1).max(100).optional(),
    receivedFrom: isoDate.optional(),
    receivedTo: isoDate.optional(),
    ...pagination,
});
export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;

/**
 * A per-variant quantity — "Red / S: 100". Used for a vendor's allotment and
 * for a consignment's lines. One entry per variant.
 */
export const variantQuantitySchema = z.object({
    variantId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(1_000_000),
});
export type VariantQuantity = z.infer<typeof variantQuantitySchema>;

export const variantQuantitiesSchema = z
    .array(variantQuantitySchema)
    .min(1)
    .max(200)
    .refine((rows) => new Set(rows.map((row) => row.variantId)).size === rows.length, {
        message: 'Each variant may appear only once.',
    });

/**
 * `quantity` and `lines` are two ways of saying how many units: a drop with
 * variants is booked as lines (the total is their sum), a drop without as a
 * plain quantity. Either is enough; when both are sent they must agree.
 */
const quantityOrLines = (
    value: { quantity?: number | undefined; lines?: VariantQuantity[] | undefined },
    ctx: z.RefinementCtx,
): void => {
    if (value.quantity === undefined && !value.lines) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['quantity'],
            message: 'Send quantity, or lines for a drop with variants.',
        });
    }
    if (value.lines && value.quantity !== undefined) {
        const total = value.lines.reduce((sum, line) => sum + line.quantity, 0);
        if (total !== value.quantity) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['quantity'],
                message: `quantity (${value.quantity}) must equal the sum of lines (${total}).`,
            });
        }
    }
};

const createBatchBaseSchema = z.object({
    vendorId: z.string().uuid(),
    /**
     * The drop this consignment was ordered for. Optional because platform
     * chip stock is bought ahead of any particular drop — and because a
     * consignment with no drop is exactly the one an org-scoped caller must
     * not see.
     */
    dropId: z.string().uuid().optional(),
    itemType: upperEnum(SupplyItemType),
    /**
     * Units the vendor says are in the carton. Reconciled against rows later.
     * Optional when `lines` is sent — it is then their sum.
     */
    quantity: z.coerce.number().int().min(1).max(1_000_000).optional(),
    /**
     * The per-variant breakdown — required by the vendor portal for a drop
     * whose vendor allotment is by variant. Needs `dropId`.
     */
    lines: variantQuantitiesSchema.optional(),
    /** The vendor's own batch label — what is printed on the carton. */
    batchRef: optionalText(100),
    receivedAt: isoDate.default(() => new Date()),
    batchDate: isoDate.optional(),
    vendorInvoiceRef: optionalText(100),
    /** Media reference for the uploaded manifest the batch was keyed from. */
    sourceFileRef: optionalText(500),
    notes: optionalText(2000),
});
export const createBatchSchema = createBatchBaseSchema
    .superRefine(quantityOrLines)
    .refine((value) => !value.lines || value.dropId, {
        message: 'Variant lines need a dropId.',
        path: ['lines'],
    });
export type CreateBatchDto = z.infer<typeof createBatchSchema>;

/** One variant line of a consignment, with its own row counters. */
export interface SupplyBatchLineResponse {
    variantId: string;
    variantCode: string;
    label: string;
    quantity: number;
    rowsReceived: number;
    rowsAccepted: number;
    rowsRejected: number;
    /** quantity − rowsReceived, never negative. */
    shortfall: number;
}

/**
 * The intake decision.
 *
 * A rejection must carry a note. Refusing a consignment is a commercial event
 * — it becomes a credit note and a conversation with the vendor — and "why"
 * is the only part of it that cannot be reconstructed afterwards.
 */
export const decideBatchSchema = z
    .object({
        status: upperEnum(SupplyBatchStatus),
        note: optionalText(2000),
        validationReportRef: optionalText(500),
    })
    .refine(
        (value) =>
            value.status !== SupplyBatchStatus.REJECTED ||
            (value.note !== undefined && value.note.length > 0),
        { message: 'A rejection must carry a note.', path: ['note'] },
    );
export type DecideBatchDto = z.infer<typeof decideBatchSchema>;

export interface SupplyBatchResponse {
    id: string;
    vendorId: string;
    vendor: { id: string; name: string; vendorType: VendorType } | null;
    dropId: string | null;
    drop: { id: string; groupCode: string; name: string } | null;
    itemType: SupplyItemType;
    status: SupplyBatchStatus;
    quantity: number;
    batchRef: string | null;
    vendorInvoiceRef: string | null;
    receivedAt: string;
    batchDate: string;
    rowsReceived: number;
    rowsAccepted: number;
    rowsRejected: number;
    sourceFileRef: string | null;
    validationReportRef: string | null;
    enteredById: string;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    /** Per-variant breakdown. Empty for a drop without variants. */
    lines: SupplyBatchLineResponse[];
    /**
     * Allotment coverage for accepting this consignment. Present on single
     * consignment reads and on vendor bookings; null when the vendor has no
     * assignment for the drop.
     */
    allotment?: AllotmentCheck | null;
    /**
     * Set on the ACCEPTED decision: the units minted into the drop from this
     * consignment's chips, per variant. Null when nothing was minted (no drop,
     * or a deployment without the minting port).
     */
    stock?: {
        minted: number;
        units: { variantId: string | null; count: number; firstSerial: number; lastSerial: number }[];
    } | null;
    /**
     * Declared quantity minus rows actually registered. Positive means the
     * carton is short against its own paperwork, which is the number the
     * intake screen exists to surface.
     */
    reconciliation: {
        declared: number;
        registered: number;
        shortfall: number;
        /** Present only for callers who reach the chip inventory. */
        tagsRegistered?: number;
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Chip manifest
// ────────────────────────────────────────────────────────────────────────────

/**
 * One row of the vendor's manifest.
 *
 * `uid` is the raw chip UID. It is hashed and encrypted on the way in and is
 * never stored, logged or returned in the clear — see the tag cipher port.
 */
export const manifestRowSchema = z.object({
    /** Hex UID as the vendor prints it; separators are tolerated and stripped. */
    uid: z
        .string()
        .trim()
        .min(8)
        .max(64)
        .transform((value) => value.replace(/[\s:-]/g, '').toUpperCase())
        .pipe(z.string().regex(/^[0-9A-F]+$/, 'A tag UID must be hexadecimal.')),
    qcStatus: upperEnum(QcStatus).optional(),
    qcNotes: optionalText(500),
    /**
     * The variant of the goods this chip is embedded in. Required when the
     * consignment has variant lines (and must be one of them); refused when it
     * has none.
     */
    variantId: z.string().uuid().optional(),
});
export type ManifestRow = z.infer<typeof manifestRowSchema>;

export const registerTagsSchema = z.object({
    tags: z.array(manifestRowSchema).min(1).max(SUPPLY_MANIFEST_MAX),
    /**
     * Parse and check the manifest without writing anything. The response is
     * shaped identically, so an intake screen can preview a carton and commit
     * the same payload.
     */
    dryRun: z.coerce.boolean().default(false),
});
export type RegisterTagsDto = z.infer<typeof registerTagsSchema>;

export interface RegisterTagsResult {
    batchId: string;
    dryRun: boolean;
    /** Rows written (or that would be written, on a dry run). */
    registered: number;
    /** Rows already present platform-wide, identified by position, never by UID. */
    duplicates: { row: number; reason: string }[];
    batch: {
        rowsReceived: number;
        rowsAccepted: number;
        rowsRejected: number;
        status: SupplyBatchStatus;
    };
    /** Per-variant counters after this manifest. Empty when the batch has no lines. */
    lines: {
        variantId: string;
        quantity: number;
        rowsReceived: number;
        rowsAccepted: number;
        rowsRejected: number;
    }[];
}

// ────────────────────────────────────────────────────────────────────────────
// Chip inventory
// ────────────────────────────────────────────────────────────────────────────

export const listTagsQuerySchema = z.object({
    supplyBatchId: z.string().uuid().optional(),
    vendorId: z.string().uuid().optional(),
    skuId: z.string().uuid().optional(),
    lifecycleState: upperEnum(TagLifecycleState).optional(),
    qcStatus: upperEnum(QcStatus).optional(),
    /** `true` for chips not yet embedded in an item — i.e. free stock. */
    unbound: z.coerce.boolean().optional(),
    /** Exact match on the platform code (`NT00000001`), which is printed on the reel. */
    nfcTagCode: z.string().trim().min(1).max(10).optional(),
    ...pagination,
});
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;

export const recordQcSchema = z.object({
    qcStatus: upperEnum(QcStatus),
    qcNotes: optionalText(500),
});
export type RecordQcDto = z.infer<typeof recordQcSchema>;

/**
 * A chip, as an operator sees it.
 *
 * There is no `uid` field and there is no capability that adds one. The hash
 * is a lookup key and the ciphertext is recovery material; neither is a thing
 * an inventory screen has any use for, and returning either would put the
 * platform's anti-counterfeiting secret in a browser's network tab.
 */
export interface NfcTagResponse {
    id: string;
    nfcTagCode: string;
    supplyBatchId: string;
    batch: { id: string; batchRef: string | null; vendorId: string; vendorName: string } | null;
    /** The variant of the goods the chip is embedded in, when the manifest said. */
    variantId: string | null;
    skuId: string | null;
    sku: { id: string; skuCode: string; serialNumber: number } | null;
    qcStatus: QcStatus;
    qcReportedAt: string | null;
    qcNotes: string | null;
    lifecycleState: TagLifecycleState;
    lastTapCounter: number;
    tamperStatus: string | null;
    personalizedAt: string | null;
    boundAt: string | null;
    activatedAt: string | null;
    retiredAt: string | null;
    createdAt: string;
    updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Metrics
// ────────────────────────────────────────────────────────────────────────────

export const supplyMetricsQuerySchema = z.object({
    /** Narrows to one organization. A filter, never a grant — it can only narrow. */
    organizationId: z.string().uuid().optional(),
    vendorId: z.string().uuid().optional(),
    /** Confines the consignment and vendor blocks to a receipt window. */
    receivedFrom: isoDate.optional(),
    receivedTo: isoDate.optional(),
});
export type SupplyMetricsQuery = z.infer<typeof supplyMetricsQuerySchema>;

/**
 * The supply/inventory rollup.
 *
 * Optional blocks are **absent, never zeroed**. A caller who may not see the
 * chip funnel gets a response with no `tags` key at all — zeroes would be a
 * lie an operator could act on, and an empty object would be indistinguishable
 * from a platform with no chips.
 */
export interface SupplyMetrics {
    generatedAt: string;
    /** The breadth the figures were computed at, from the caller's own grants. */
    scope: 'GLOBAL' | 'ORGANIZATION';
    organizationIds: string[] | null;
    /** The NFC chip funnel. Requires `nfc-tag-claim:read`. */
    tags?: {
        total: number;
        byLifecycle: Record<string, number>;
        byQc: Record<string, number>;
        /** Percentage string, two decimals — never a float to compare against. */
        qcFailureRate: string;
        /** Chips not embedded in any item: free stock. */
        unbound: number;
        bound: number;
    };
    /** Consignment intake. Requires `drop:read` at operator grade. */
    batches?: {
        total: number;
        byStatus: Record<string, number>;
        byItemType: Record<string, number>;
        quantityDeclared: number;
        rowsReceived: number;
        rowsAccepted: number;
        rowsRejected: number;
        acceptanceRate: string;
        /** Consignments still awaiting a decision. */
        pendingReview: number;
    };
    /** Vendor reliability. Requires `drop:read` at operator grade. */
    vendors?: {
        active: number;
        byType: Record<string, number>;
        leaders: {
            vendorId: string;
            name: string;
            vendorType: VendorType;
            batches: number;
            quantityDeclared: number;
            rowsAccepted: number;
            rowsRejected: number;
            rejectionRate: string;
        }[];
    };
    /** Serialized stock across drops. Requires `drop:read` at operator grade. */
    inventory?: {
        drops: number;
        totalSupply: number;
        minted: number;
        unminted: number;
        claimed: number;
        unclaimed: number;
        /** Minted units carrying a chip. Requires `nfc-tag-claim:read`. */
        tagged?: number;
        untagged?: number;
    };
    /** Where the paperwork and the shelf disagree. */
    reconciliation?: {
        /** Consignments whose registered rows fall short of the declared quantity. */
        shortfalls: {
            batchId: string;
            batchRef: string | null;
            vendorName: string;
            declared: number;
            registered: number;
            shortfall: number;
        }[];
        /** Free chip stock, platform-wide. Requires `nfc-tag-claim:read`. */
        unboundTagStock?: number;
        /** Minted units still waiting for a chip. Requires `nfc-tag-claim:read`. */
        untaggedUnits?: number;
    };
    /** Drops running out of unminted supply. */
    lowStock?: {
        productId: string;
        groupCode: string;
        name: string;
        totalSupply: number;
        minted: number;
        remaining: number;
        percentRemaining: string;
    }[];
}

export { QcStatus, SupplyBatchStatus, SupplyItemType, TagLifecycleState, VendorType };

// ────────────────────────────────────────────────────────────────────────────
// Vendor portal — administration (HitBox staff)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Invite someone to sign in for a vendor. `email` defaults to the vendor's
 * `contactEmail`, so "invite this vendor" is a body-less POST for the common
 * case of one contact per supplier.
 */
export const inviteVendorMemberSchema = z.object({
    email: optionalWhenBlank(z.string().trim().email().max(320)),
});
export type InviteVendorMemberDto = z.infer<typeof inviteVendorMemberSchema>;

export const listVendorMembersQuerySchema = z.object({
    status: upperEnum(VendorMemberStatus).optional(),
});
export type ListVendorMembersQuery = z.infer<typeof listVendorMembersQuerySchema>;

export const revokeVendorMemberSchema = z.object({
    reason: z.string().trim().min(1).max(500),
});
export type RevokeVendorMemberDto = z.infer<typeof revokeVendorMemberSchema>;

/**
 * What a vendor is to supply for one drop.
 *
 *   - drop WITH variants    → `variants` (required): "Red/S 100, Red/M 100, Red/L 100"
 *   - drop WITHOUT variants → `quantity` (optional cap; omit for no cap)
 */
const allotmentFields = {
    variants: variantQuantitiesSchema.optional(),
    quantity: z.coerce.number().int().min(1).max(1_000_000).nullish(),
};
const notBoth = (value: { variants?: unknown; quantity?: number | null | undefined }) =>
    !(value.variants && value.quantity != null);
const notBothMessage = {
    message: 'Send variants for a drop with variants, or quantity for one without — not both.',
    path: ['quantity'],
};

export const assignVendorDropSchema = z
    .object({ dropId: z.string().uuid(), ...allotmentFields })
    .refine(notBoth, notBothMessage);
export type AssignVendorDropDto = z.infer<typeof assignVendorDropSchema>;

/**
 * Raises (or lowers) specific parts of an allotment. Variants sent are set —
 * added when new — and every other variant keeps its allotment. This is the
 * route an admin uses to cover an over-allotment consignment before accepting
 * it; the 409 from the accept carries the exact body as `suggestedPatch`.
 */
export const patchVendorAllotmentSchema = z
    .object(allotmentFields)
    .refine(notBoth, notBothMessage)
    .refine((value) => value.variants !== undefined || value.quantity !== undefined, {
        message: 'Send variants or quantity.',
    });
export type PatchVendorAllotmentDto = z.infer<typeof patchVendorAllotmentSchema>;

/** Replaces the allotment of an existing assignment. Same shape, no dropId. */
export const updateVendorAllotmentSchema = z.object(allotmentFields).refine(notBoth, notBothMessage);
export type UpdateVendorAllotmentDto = z.infer<typeof updateVendorAllotmentSchema>;

/** Supply progress against an allotment. `remaining` is null when there is no cap. */
export interface AllotmentProgress {
    allotted: number | null;
    /** Units in this vendor's non-rejected consignments for the drop. */
    booked: number;
    /** Chips registered against those consignments. */
    registered: number;
    /** Of those, not failed QC. */
    accepted: number;
    /** Units in consignments HitBox has ACCEPTED — what the allotment must cover. */
    approved: number;
    /** allotted − booked, never negative. Null when there is no cap. */
    remaining: number | null;
    /** booked − allotted, never negative: units booked beyond the allotment. */
    overBooked: number;
}

/**
 * Whether accepting a consignment stays within the vendor's allotment. Shown
 * on consignment reads so the admin knows before deciding; the accept itself
 * is refused with this as `details` while `covered` is false.
 */
export interface AllotmentCheck {
    covered: boolean;
    byVariant: boolean;
    variants: {
        variantId: string;
        variantCode: string;
        label: string;
        allotted: number;
        /** Units in the vendor's other ACCEPTED consignments for this variant. */
        acceptedElsewhere: number;
        thisBatch: number;
        required: number;
        shortBy: number;
    }[];
    /** Drop-level figures, when the check is not per variant. */
    total: {
        allotted: number | null;
        acceptedElsewhere: number;
        thisBatch: number;
        required: number;
        shortBy: number;
    } | null;
    /** The PATCH …/allotment body that would cover this consignment, when one would. */
    suggestedPatch: { variants?: VariantQuantity[]; quantity?: number } | null;
}

export interface VariantAllotmentResponse extends AllotmentProgress {
    variantId: string;
    /** Null for a variant booked without an allotment (listed at allotted 0). */
    variantCode: string | null;
    label: string | null;
    /** Canonical options, e.g. `color=RED|size=S`. */
    options: string | null;
}

export interface VendorMemberResponse {
    id: string;
    vendorId: string;
    email: string;
    status: VendorMemberStatus;
    userId: string | null;
    invitationId: string | null;
    invitedById: string;
    invitedAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
    revokeReason: string | null;
}

export interface InviteVendorMemberResult {
    /** ROLE_ASSIGNED when the address already had an account; INVITATION_SENT otherwise. */
    outcome: 'ROLE_ASSIGNED' | 'INVITATION_SENT';
    member: VendorMemberResponse;
    invitationExpiresAt: string;
}

export interface VendorDropAssignmentResponse {
    id: string;
    vendorId: string;
    dropId: string;
    drop: { id: string; groupCode: string; name: string; status: string };
    assignedById: string;
    assignedAt: string;
    /** True when the allotment is by variant (see `variants`). */
    byVariant: boolean;
    /** Drop-level totals (sum of variants for a by-variant allotment). */
    progress: AllotmentProgress;
    /** Per-variant allotment and progress. Empty for a drop without variants. */
    variants: VariantAllotmentResponse[];
}

// ────────────────────────────────────────────────────────────────────────────
// Vendor portal — self-service (the vendor)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A consignment booked by the vendor. Identical to the admin body minus
 * `vendorId` — always the caller's own vendor — and with `dropId` required:
 * a vendor only ever supplies a drop it was assigned to.
 */
export const vendorCreateBatchSchema = createBatchBaseSchema
    .omit({ vendorId: true, dropId: true })
    .extend({ dropId: z.string().uuid() })
    .superRefine(quantityOrLines);
export type VendorCreateBatchDto = z.infer<typeof vendorCreateBatchSchema>;

export const vendorListBatchesQuerySchema = listBatchesQuerySchema.omit({ vendorId: true });
export type VendorListBatchesQuery = z.infer<typeof vendorListBatchesQuerySchema>;

export interface VendorProfileResponse {
    member: VendorMemberResponse;
    vendor: {
        id: string;
        name: string;
        legalName: string | null;
        country: string | null;
        vendorType: VendorType;
        contactName: string | null;
        contactEmail: string | null;
        contactPhone: string | null;
        isActive: boolean;
    };
}
