import { z } from 'zod';
import type { ClaimedStatus, DropStatus, LedgerTxType } from '@hitbox/database';

// ── Path params ─────────────────────────────────────────────────────────

/** Every NFC route is keyed by the tag id burned into the chip. */
export const tagIdParamSchema = z.object({
    tagId: z.string().trim().min(1).max(64),
});

export type TagIdParam = z.infer<typeof tagIdParamSchema>;

// ── Mutations ───────────────────────────────────────────────────────────

/**
 * Claim carries no required body — the tag is in the path and the owner is the
 * authenticated caller. An optional visibility lets the buyer immediately
 * make the new collection entry public.
 */
export const claimBodySchema = z
    .object({
        visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
    })
    .strict();

export type ClaimBodyDto = z.infer<typeof claimBodySchema>;

// ── Response shapes ───────────────────────────────────────────────────────

/**
 * Minimal public view of a user attached to a SKU/ledger row.
 *
 * `username` became `handle` in the users restructure — `User.username`,
 * `firstName` and `lastName` no longer exist.
 */
export interface OwnerView {
    id: string;
    handle: string | null;
    displayName: string | null;
}

/**
 * GET /verify/:tagId
 *
 * A tag identifies a SKU, so this now reports the serialized item AND the
 * catalog entry behind it. `state` became `status` (`DropStatus`), and
 * `claimedStatus` moved from the product to the SKU.
 */
export interface VerifyResult {
    valid: boolean;
    skuId: string;
    skuCode: string;
    /** Position within the edition — "#14 of 500". */
    serialNumber: number;
    productId: string;
    /** The product's public code (was `productCode`, now `Product.groupCode`). */
    groupCode: string;
    name: string;
    claimed: boolean;
    claimedStatus: ClaimedStatus;
    status: DropStatus;
    owner: OwnerView | null;
    /** Length of the provenance chain (number of ledger rows). */
    ledgerLength: number;
    verifiedAt: string;
}

/**
 * POST /claims/:tagId — validate step. Reads the tag and tells the app which
 * screen to show WITHOUT mutating anything. The actual claim happens on confirm.
 */
export interface ValidateResult {
    tagId: string;
    /** Screen the app should render. */
    screen: 'CLAIMABLE' | 'ALREADY_CLAIMED_BY_YOU' | 'ALREADY_CLAIMED';
    claimedByYou: boolean;
    sku: {
        id: string;
        skuCode: string;
        serialNumber: number;
        tagId: string | null;
    };
    product: {
        id: string;
        groupCode: string;
        name: string;
        /** Base price in the default market; null when none is configured. */
        priceInDollars: string | null;
        currency: string | null;
        status: DropStatus;
        imageUrl: string | null;
    };
    owner: OwnerView | null;
    claimedAt: string | null;
}

/**
 * POST /claims/:tagId/confirm — the single NFC claim result.
 * `outcome` is `CLAIMED` when this call claimed the product, or
 * `ALREADY_CLAIMED` when someone had already claimed it (then `owner` names
 * who). `claimedByYou` is true when the caller is the owner in either case.
 */
export interface ClaimFlowResult {
    outcome: 'CLAIMED' | 'ALREADY_CLAIMED';
    claimedByYou: boolean;
    message: string;
    owner: OwnerView;
    sku: {
        id: string;
        skuCode: string;
        serialNumber: number;
        tagId: string | null;
        claimedStatus: ClaimedStatus;
    };
    product: {
        id: string;
        groupCode: string;
        name: string;
    };
    claimedAt: string | null;
    /** The claim record — present only when this tap performed the claim. */
    claim: { id: string; claimCode: string; claimedNo: number } | null;
}

/**
 * A single blockchain-ledger record, shaped to the demo spec columns:
 * Product Id | Tag # | Owner Id | DateTime of Creation | Hash # | Claim History | PeerToPeer Trading
 */
export interface LedgerEntryView {
    sequenceNo: number;
    txType: LedgerTxType;
    /** Product Id — the human product code (`Product.groupCode`). */
    productId: string;
    /** Tag # — the NFC tag id. */
    tag: string | null;
    /** Owner Id — "HitBox" for the origin record, else the owner's name. */
    ownerId: string;
    /** DateTime of Creation (ISO 8601). */
    dateTime: string;
    /** Hash # — SHA-256(Product ID + Tag Id + Owner Id + DateTime). */
    hash: string;
    /** Hash of the previous record in the chain (null for the origin record). */
    previousHash: string | null;
    /** Claim History — Yes/No: is this record a claim? */
    claimHistory: boolean;
    /** PeerToPeer Trading — Yes/No: is this owner eligible to trade P2P? */
    peerToPeerTrading: boolean;
}
