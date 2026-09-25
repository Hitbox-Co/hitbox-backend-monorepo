import { ClaimedStatus, TagLifecycleState } from '@hitbox/database';
import { z } from 'zod';
import {
    SKU_BATCH_RANGE_MAX,
    SKU_BATCH_UPDATE_MAX,
    SKU_MINT_MAX_BATCH,
    SKU_TAG_BIND_MAX,
    SKUS_DEFAULT_LIMIT,
    SKUS_MAX_LIMIT,
} from '../constants/skus.constant';

/**
 * A query-string boolean.
 *
 * NOT `z.coerce.boolean()`, which is `Boolean(input)` — and `Boolean('false')`
 * is `true`. Every `?flag=false` in a query string parsed that way means the
 * opposite of what it says, which on `?tagged=false` silently returns the
 * tagged units and on `?includeArchived=false` includes the archived ones.
 */
const booleanish = z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

/**
 * A repeatable query parameter, accepted as `?k=a,b` or `?k=a&k=b`.
 *
 * Express gives the second form as an array and the first as a string; a
 * client should not have to know which one this API prefers.
 */
const csvOf = <T extends z.ZodTypeAny>(item: T, max: number) =>
    z
        .union([z.string(), z.array(z.string())])
        .transform((value) =>
            (Array.isArray(value) ? value : value.split(','))
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
        )
        .pipe(z.array(item).min(1).max(max));

const csvEnum = <T extends Record<string, string>>(enumObject: T, max = 20) =>
    csvOf(z.nativeEnum(enumObject), max);

/**
 * A physical NFC tag UID.
 *
 * Hex with optional separators, because that is what every reader in the
 * supply chain emits; normalised to upper case without separators so the same
 * physical tag can never be bound twice under two spellings. `Sku.tagId` is
 * unique platform-wide and that uniqueness is the primary defence against
 * cloned tags — it only works if the stored form is canonical.
 */
const tagId = z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[0-9a-fA-F][0-9a-fA-F:\- ]*[0-9a-fA-F]$/, 'Hex, optionally separated by ":" or "-"')
    .transform((value) => value.replace(/[:\- ]/g, '').toUpperCase());

// ── Mint ────────────────────────────────────────────────────────────────────

export const mintSkusSchema = z
    .object({
        /** How many units to create. Serials continue from the highest existing one. */
        count: z.number().int().min(1).max(SKU_MINT_MAX_BATCH),
        /** Optional variant every minted unit belongs to. Must be the product's own. */
        variantId: z.string().uuid().optional(),
        /**
         * Tag UIDs to bind, in serial order. Either omit it entirely or supply
         * exactly `count` of them — a short list would silently leave the tail
         * of the batch untagged, and "silently" is not a property you want in
         * the table that proves authenticity.
         *
         * Requires `nfc-tag-claim:manage`; minting alone is not enough.
         */
        tagIds: z.array(tagId).min(1).max(SKU_MINT_MAX_BATCH).optional(),
        /**
         * Which vendor provisioned the tags, and the batch reference they came
         * in under. Recorded, not verified — the supply module owns batches and
         * tags routinely arrive before that row exists.
         */
        vendorId: z.string().uuid().optional(),
        provisioningBatchId: z.string().trim().min(1).max(120).optional(),
        /** Mint inactive when the units are staged ahead of a release. */
        isActive: z.boolean().default(true),
    })
    .strict()
    .refine((value) => !value.tagIds || value.tagIds.length === value.count, {
        message: 'tagIds must contain exactly `count` entries when supplied',
        path: ['tagIds'],
    })
    .refine((value) => !value.tagIds || new Set(value.tagIds).size === value.tagIds.length, {
        message: 'tagIds contains the same tag twice',
        path: ['tagIds'],
    });

export type MintSkusDto = z.infer<typeof mintSkusSchema>;

// ── Tag binding ─────────────────────────────────────────────────────────────

/**
 * Bind one tag to one already-minted unit.
 *
 * This is the endpoint that makes a 500-unit edition practical: mint the units
 * first with no tags, then bind as the physical tags arrive from the vendor.
 * Supplying 500 UIDs at mint time requires knowing all 500 before a single
 * unit exists, which is not how tag provisioning works.
 */
export const bindTagSchema = z
    .object({
        tagId,
        vendorId: z.string().uuid().optional(),
        provisioningBatchId: z.string().trim().min(1).max(120).optional(),
        /**
         * Overwrite a tag that is already bound.
         *
         * Off by default: re-tagging is a physical-world event (a chip failed,
         * an item was re-tagged after repair), not something a retried request
         * should do silently. Refused outright on a CLAIMED unit whose tag is
         * still healthy — the owner's app and the hash chain are keyed to it.
         */
        replace: z.boolean().default(false),
    })
    .strict();
export type BindTagDto = z.infer<typeof bindTagSchema>;

/** One row of a vendor manifest: which unit, which tag. */
const tagBindingSchema = z
    .object({
        /** Identify the unit by its position in the edition… */
        serialNumber: z.coerce.number().int().min(1).optional(),
        /** …or by its full code. Exactly one of the two. */
        skuCode: z.string().trim().min(1).max(64).optional(),
        tagId,
    })
    .strict()
    .refine(
        (value) =>
            (value.serialNumber === undefined) !== (value.skuCode === undefined),
        { message: 'Provide exactly one of serialNumber or skuCode' },
    );

/**
 * `POST /admin/products/:productId/skus/tags` — bind a batch.
 *
 * Shaped to be a direct translation of a vendor's CSV manifest
 * (`serial,tagId` per line), because that is what actually arrives with a box
 * of tags.
 */
export const bulkBindTagsSchema = z
    .object({
        bindings: z.array(tagBindingSchema).min(1).max(SKU_TAG_BIND_MAX),
        vendorId: z.string().uuid().optional(),
        provisioningBatchId: z.string().trim().min(1).max(120).optional(),
        replace: z.boolean().default(false),
    })
    .strict()
    .refine(
        (value) => new Set(value.bindings.map((b) => b.tagId)).size === value.bindings.length,
        { message: 'The same tag appears twice in this batch', path: ['bindings'] },
    )
    .refine(
        (value) => {
            const keys = value.bindings.map((b) => b.skuCode ?? `#${b.serialNumber}`);
            return new Set(keys).size === keys.length;
        },
        { message: 'The same unit appears twice in this batch', path: ['bindings'] },
    );
export type BulkBindTagsDto = z.infer<typeof bulkBindTagsSchema>;

export interface BulkBindResult {
    productId: string;
    bound: number;
    items: { skuCode: string; serialNumber: number; tagId: string; replaced: boolean }[];
}

// ── Updating a unit ─────────────────────────────────────────────────────────

/**
 * The editable surface of a `Sku` row.
 *
 * Every key is optional and **absence means "leave it alone"** — this is a
 * PATCH, not a PUT. `null` is a value: `variantId: null` detaches the variant,
 * `tamperStatus: null` clears the note. A client that sends its whole form
 * object every time will therefore write exactly what is on the form, which is
 * usually what it wanted; a client that sends only the changed field writes
 * only that. Both are correct.
 *
 * `.strict()` is load-bearing. `ownerId`, `serialNumber`, `skuCode`,
 * `claimToken` and `lastTapCounter` are not editable, and a body naming one is
 * a `422` rather than a silently ignored field — a caller who believes they
 * just transferred ownership should find out immediately.
 *
 * Which of these fields a caller may actually write, and which the unit's own
 * state still refuses, is decided in domain/sku-update.ts.
 */
export const skuChangesSchema = z
    .object({
        /** Must belong to this unit's product. `null` detaches it. */
        variantId: z.string().uuid().nullable().optional(),
        /** Listing availability. `false` stages a unit ahead of a release. */
        isActive: z.boolean().optional(),
        /** `true` archives (and delists); `false` restores. Refused on a held unit. */
        archived: z.boolean().optional(),
        /** Freezes resale. Requires a reason, here or already on the row. */
        resaleBlocked: z.boolean().optional(),
        resaleBlockedReason: z.string().trim().max(500).nullable().optional(),
        /** Free-text investigation note, e.g. `SEAL_BROKEN`. `null` clears it. */
        tamperStatus: z.string().trim().max(120).nullable().optional(),
        /**
         * The investigation freeze. `true` sets `claimedStatus` to `FLAGGED`;
         * `false` releases it back to CLAIMED or UNCLAIMED depending on whether
         * the unit has an owner. The only way `claimedStatus` is writable here.
         */
        flagged: z.boolean().optional(),

        // ── Tag custody — requires `nfc-tag-claim:manage` ───────────────────
        /** `LOST` / `REVOKED` / `DISPUTED`, or back to `BOUND`. Never `ACTIVE`. */
        tagLifecycleState: z.nativeEnum(TagLifecycleState).optional(),
        vendorId: z.string().uuid().nullable().optional(),
        provisioningBatchId: z.string().trim().min(1).max(120).nullable().optional(),
        /** Records (or clears) `vendorAuthenticatedAt`. */
        vendorAuthenticated: z.boolean().optional(),

        /**
         * Why. Kept in the audit trail, not on the row.
         *
         * Required for freezing, archiving, and marking a tag LOST or REVOKED.
         */
        reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict();

export type SkuChangesDto = z.infer<typeof skuChangesSchema>;

/** `PATCH /admin/skus/:skuId`. */
export const updateSkuSchema = skuChangesSchema;
export type UpdateSkuDto = SkuChangesDto;

// ── Updating a batch ────────────────────────────────────────────────────────

/**
 * Which units a batch edit applies to. Exactly one selector.
 *
 * Four, because an operator arrives holding four different things: a selection
 * from a table (`skuIds`), a scanned or pasted list (`skuCodes`), a list of
 * positions read off cards (`serialNumbers`), or a contiguous block of an
 * edition — "archive #401 to #500", which is `serialFrom`/`serialTo` and would
 * otherwise be a hundred-element array.
 *
 * The three that name units by their position in an edition are meaningless
 * without a drop, so they require a `productId` — in the path on the nested
 * route, in the body on the cross-drop one.
 */
export const batchTargetsSchema = z
    .object({
        skuIds: z.array(z.string().uuid()).min(1).max(SKU_BATCH_UPDATE_MAX).optional(),
        skuCodes: z
            .array(z.string().trim().min(1).max(64))
            .min(1)
            .max(SKU_BATCH_UPDATE_MAX)
            .optional(),
        serialNumbers: z
            .array(z.coerce.number().int().min(1))
            .min(1)
            .max(SKU_BATCH_UPDATE_MAX)
            .optional(),
        serialFrom: z.number().int().min(1).optional(),
        serialTo: z.number().int().min(1).optional(),
    })
    .strict()
    .refine(
        (value) =>
            [
                value.skuIds !== undefined,
                value.skuCodes !== undefined,
                value.serialNumbers !== undefined,
                value.serialFrom !== undefined || value.serialTo !== undefined,
            ].filter(Boolean).length === 1,
        {
            message:
                'Provide exactly one of: skuIds, skuCodes, serialNumbers, or a ' +
                'serialFrom/serialTo range',
        },
    )
    .refine(
        (value) =>
            (value.serialFrom === undefined) === (value.serialTo === undefined),
        { message: 'A serial range needs both serialFrom and serialTo' },
    )
    .refine(
        (value) =>
            value.serialFrom === undefined ||
            value.serialTo === undefined ||
            value.serialTo >= value.serialFrom,
        { message: 'serialTo must not be below serialFrom', path: ['serialTo'] },
    )
    .refine(
        (value) =>
            value.serialFrom === undefined ||
            value.serialTo === undefined ||
            value.serialTo - value.serialFrom + 1 <= SKU_BATCH_RANGE_MAX,
        {
            message: `A serial range may span at most ${SKU_BATCH_RANGE_MAX} units`,
            path: ['serialTo'],
        },
    )
    .refine(
        (value) => !value.skuIds || new Set(value.skuIds).size === value.skuIds.length,
        { message: 'skuIds contains the same unit twice', path: ['skuIds'] },
    )
    .refine(
        (value) => !value.skuCodes || new Set(value.skuCodes).size === value.skuCodes.length,
        { message: 'skuCodes contains the same unit twice', path: ['skuCodes'] },
    )
    .refine(
        (value) =>
            !value.serialNumbers ||
            new Set(value.serialNumbers).size === value.serialNumbers.length,
        { message: 'serialNumbers contains the same unit twice', path: ['serialNumbers'] },
    );

export type BatchTargetsDto = z.infer<typeof batchTargetsSchema>;

/**
 * `PATCH /admin/skus/batch` and `PATCH /admin/products/:productId/skus/batch`.
 *
 * One set of changes, applied to every selected unit, in one transaction.
 * Deliberately **not** a list of per-unit edits: the screen this serves is
 * "select these 200 rows, block resale", and a per-unit payload would be the
 * tag-manifest endpoint with a worse name.
 *
 * `dryRun` resolves and validates everything and writes nothing, so a console
 * can say "this will change 187 of the 200 units you selected; 13 are already
 * blocked" before anybody commits to it.
 */
export const batchUpdateSkusSchema = z
    .object({
        /** Required by the cross-drop route when targeting by serial or code. */
        productId: z.string().uuid().optional(),
        targets: batchTargetsSchema,
        changes: skuChangesSchema,
        dryRun: z.boolean().default(false),
    })
    .strict();

export type BatchUpdateSkusDto = z.infer<typeof batchUpdateSkusSchema>;

export interface BatchUpdateItem {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    /** Columns this unit would change, or did. Empty when it was already there. */
    changed: string[];
}

export interface BatchUpdateResult {
    productId: string | null;
    /** How many units the selector named. */
    requested: number;
    /** How many of them exist and the caller can reach. */
    matched: number;
    /** How many actually differ from the requested state. */
    changed: number;
    /** Matched but already in the requested state — a no-op, not a failure. */
    unchanged: number;
    /** True when nothing was written. */
    dryRun: boolean;
    items: BatchUpdateItem[];
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * The inventory filter set.
 *
 * Written for the screen it serves: an operator looking at "everything in this
 * drop", narrowing to "the 40 units in batch BATCH-2026-09-41 that are still
 * untagged", and then acting on exactly that selection through the batch
 * endpoint. The filters here and the target selectors on
 * `batchUpdateSkusSchema` are intentionally the same vocabulary.
 *
 * **Filtering a column is a read of it.** A caller who may not see tag UIDs may
 * not filter by one either — see domain/sku-filters.ts for why, and for which
 * of these are gated.
 *
 * Enum filters accept several values: `?claimedStatus=UNCLAIMED,FLAGGED`.
 */
export const listSkusQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(SKUS_MAX_LIMIT).default(SKUS_DEFAULT_LIMIT),

    // ── Which drop ──────────────────────────────────────────────────────────
    /** Only meaningful on the cross-drop list; the nested route has it in the path. */
    productId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    /** `false` lists units belonging to no variant. */
    hasVariant: booleanish.optional(),

    // ── Which units ─────────────────────────────────────────────────────────
    claimedStatus: csvEnum(ClaimedStatus).optional(),
    tagLifecycleState: csvEnum(TagLifecycleState).optional(),
    serialFrom: z.coerce.number().int().min(1).optional(),
    serialTo: z.coerce.number().int().min(1).optional(),
    skuCode: csvOf(z.string().trim().min(1).max(64), 200).optional(),

    // ── Tag custody — gated on `nfc-tag-claim` ──────────────────────────────
    /** `true` lists only units with a tag bound; `false` only untagged ones. */
    tagged: booleanish.optional(),
    tagId: tagId.optional(),
    vendorId: z.string().uuid().optional(),
    provisioningBatchId: z.string().trim().min(1).max(120).optional(),

    // ── Trust — gated on `collectible-instance` at FULL visibility ──────────
    resaleBlocked: booleanish.optional(),
    /** `true` lists units carrying any tamper note; `false` only clean ones. */
    tampered: booleanish.optional(),
    tamperStatus: z.string().trim().min(1).max(120).optional(),

    // ── Ownership — gated on `buyer-profile` at FULL visibility ─────────────
    ownerId: z.string().uuid().optional(),
    /** Ungated: `claimedStatus=CLAIMED` already answers the same question. */
    hasOwner: booleanish.optional(),

    // ── Lifecycle ───────────────────────────────────────────────────────────
    isActive: booleanish.optional(),
    /** Omit to list live units only. */
    includeArchived: booleanish.default(false),
    /** Lists the archived ones and nothing else. Implies `includeArchived`. */
    archivedOnly: booleanish.default(false),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    updatedFrom: z.coerce.date().optional(),
    updatedTo: z.coerce.date().optional(),

    /** Matches a serial number, a `skuCode` fragment, or a full tag UID. */
    search: z.string().trim().min(1).max(64).optional(),
    sort: z
        .enum([
            'serial_asc',
            'serial_desc',
            'newest',
            'oldest',
            'recently_updated',
            'code_asc',
        ])
        .default('serial_asc'),
})
    .refine(
        (value) =>
            value.serialFrom === undefined ||
            value.serialTo === undefined ||
            value.serialFrom <= value.serialTo,
        { message: 'serialFrom must not exceed serialTo', path: ['serialFrom'] },
    );
export type ListSkusQuery = z.infer<typeof listSkusQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

/**
 * Every optional block below is **omitted entirely** when the caller may not
 * see it — never present-but-null. An absent key means "you were not shown
 * this"; a null value means "we looked and there is nothing there". A client
 * that renders "Owner: —" for an unclaimed unit and "Owner: —" for a
 * permission it lacks has lost the distinction that matters.
 */
export interface SkuListItem {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    claimedStatus: ClaimedStatus;
    variantId: string | null;
    isActive: boolean;
    archivedAt: string | null;
    createdAt: string;
    /** Moves on every edit — what `sort=recently_updated` orders by. */
    updatedAt: string;
    /** Gated on `collectible-instance` at FULL visibility. */
    trust?: {
        resaleBlocked: boolean;
        resaleBlockedReason: string | null;
        tamperStatus: string | null;
    };
    /** Gated on `nfc-tag-claim`. */
    tag?: {
        tagId: string | null;
        tagLifecycleState: TagLifecycleState;
        lastTapCounter?: number;
        /**
         * Where the tag came from. FULL only: a batch reference identifies the
         * consignment a UID belongs to, which is tag-custody material in the
         * same way the UID is.
         */
        vendorId?: string | null;
        provisioningBatchId?: string | null;
        vendorAuthenticatedAt?: string | null;
    };
    /** Gated on `buyer-profile`. */
    owner?: {
        ownerId: string | null;
        email: string | null;
        handle: string | null;
    };
}

export interface SkuDetail extends SkuListItem {
    product: {
        productId: string;
        groupCode: string;
        name: string;
        organizationId: string | null;
        status: string;
        totalSupply: number;
    };
    /** Gated on `nfc-tag-claim`; the claim token itself is never returned. */
    provenance?: {
        claimCount: number;
        ledgerEntries: number;
        firstClaimedAt: string | null;
        currentHolderSince: string | null;
        /** Present only when the caller may also see money. */
        currentHolderPaid?: { amount: string | null; currency: string | null };
    };
    /** Gated on `order`. */
    commerce?: {
        allocatedOrderId: string | null;
        allocatedOrderStatus: string | null;
        reservationStatus: string | null;
        /** Present only when the caller may also see money. */
        amount?: string | null;
        currency?: string | null;
    };
}

export interface SkuSummary {
    productId: string;
    total: number;
    byClaimedStatus: Record<string, number>;
    /** Gated on `nfc-tag-claim` — omitted entirely otherwise. */
    byTagLifecycleState?: Record<string, number>;
    tagged?: number;
    untagged?: number;
    /** How many more units the product's `totalSupply` still allows. */
    remainingSupply: number | null;
}

export interface MintResult {
    productId: string;
    minted: number;
    firstSerial: number;
    lastSerial: number;
    skuCodes: string[];
    tagsBound: number;
}

export { ClaimedStatus, TagLifecycleState };
