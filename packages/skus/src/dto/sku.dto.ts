import { ClaimedStatus, TagLifecycleState } from '@hitbox/database';
import { z } from 'zod';
import {
    SKU_MINT_MAX_BATCH,
    SKU_TAG_BIND_MAX,
    SKUS_DEFAULT_LIMIT,
    SKUS_MAX_LIMIT,
} from '../constants/skus.constant';

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

// ── Queries ─────────────────────────────────────────────────────────────────

export const listSkusQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(SKUS_MAX_LIMIT).default(SKUS_DEFAULT_LIMIT),
    claimedStatus: z.nativeEnum(ClaimedStatus).optional(),
    tagLifecycleState: z.nativeEnum(TagLifecycleState).optional(),
    variantId: z.string().uuid().optional(),
    /** `true` lists only units with a tag bound; `false` only untagged ones. */
    tagged: z.coerce.boolean().optional(),
    resaleBlocked: z.coerce.boolean().optional(),
    /** Omit to list live units only. */
    includeArchived: z.coerce.boolean().default(false),
    /** Matches a serial number, a skuCode suffix, or a full tag UID. */
    search: z.string().trim().min(1).max(64).optional(),
    sort: z.enum(['serial_asc', 'serial_desc', 'newest']).default('serial_asc'),
});
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
