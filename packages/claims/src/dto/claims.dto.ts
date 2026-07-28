import { z } from 'zod';
import type { ClaimedStatus, LedgerTxType, ProductState } from '@hitbox/database';

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

/** Minimal public view of a user attached to a product/ledger row. */
export interface OwnerView {
    id: string;
    username: string | null;
    displayName: string | null;
}

/** GET /verify/:tagId */
export interface VerifyResult {
    valid: boolean;
    productId: string;
    productCode: string;
    name: string;
    claimed: boolean;
    claimedStatus: ClaimedStatus;
    state: ProductState;
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
    product: {
        id: string;
        productCode: string;
        name: string;
        tagId: string | null;
        priceInDollars: string;
        rewardPoints: number;
        state: ProductState;
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
    product: {
        id: string;
        productCode: string;
        name: string;
        tagId: string | null;
        claimedStatus: ClaimedStatus;
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
    /** Product Id — the human product code, e.g. "A1000000000000". */
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
